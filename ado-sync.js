require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;

if (!ADO_ORG || !ADO_PROJECT || !ADO_PAT) {
  console.error('Missing environment variables');
  process.exit(1);
}

const authHeader = Buffer.from(`:${ADO_PAT}`).toString('base64');

const adoClient = axios.create({
  baseURL: `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis`,
  headers: {
    'Authorization': `Basic ${authHeader}`,
    'Content-Type': 'application/json'
  }
});

// Convertir T-Shirt Size a SP equivalentes
function tShirtToSP(size) {
  const mapping = {
    'XS': 5,
    'S': 10,
    'M': 17,
    'L': 35
  };
  return mapping[size] || 0;
}

// Convertir T-Shirt Size a Sprints
function tShirtToSprints(size) {
  const mapping = {
    'XS': 1,
    'S': 2,
    'M': 3,
    'L': 4
  };
  return mapping[size] || 0;
}

// Obtener Features
async function fetchFeatures() {
  try {
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.WorkItemType] = "Feature" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3") AND [System.State] = "In Process" AND [System.ChangedDate] >= @today - 90'
    });

    const ids = response.data.workItems.map(item => item.id);
    if (ids.length === 0) return [];

    const batch = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'Microsoft.VSTS.Scheduling.TargetDate', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });

    return batch.data.value.map(item => {
      const be = item.fields['Custom.BEEstimate'] || '';
      const fe = item.fields['Custom.FEEstimates'] || '';
      const qa = item.fields['Custom.QASizing'] || '';
      
      const beSprintSP = tShirtToSP(be);
      const feSprintSP = tShirtToSP(fe);
      const qaSprintSP = tShirtToSP(qa);
      
      const maxSprintSP = Math.max(beSprintSP, feSprintSP, qaSprintSP);
      const estimatedSprints = tShirtToSprints(be || fe || qa || 'XS');
      
      return {
        id: item.id,
        title: item.fields['System.Title'] || '',
        state: item.fields['System.State'] || '',
        targetDate: item.fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
        estimation: {
          be: be,
          fe: fe,
          qa: qa,
          maxSprintSP: maxSprintSP,
          estimatedSprints: estimatedSprints
        }
      };
    });
  } catch (error) {
    console.error('Error fetching features:', error.message);
    throw error;
  }
}

// Obtener User Stories
async function fetchStories() {
  try {
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title], [System.State], [System.Parent], [Microsoft.VSTS.Scheduling.StoryPoints] FROM workitems WHERE [System.WorkItemType] = "User Story" AND [System.State] IN ("New", "In Progress", "In Review", "Done")'
    });

    const ids = response.data.workItems.map(item => item.id);
    if (ids.length === 0) return [];

    const batch = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.Parent', 'Microsoft.VSTS.Scheduling.StoryPoints']
    });

    return batch.data.value.map(item => ({
      id: item.id,
      title: item.fields['System.Title'] || '',
      state: item.fields['System.State'] || '',
      parentId: item.fields['System.Parent'] || null,
      storyPoints: parseInt(item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0) || 0
    }));
  } catch (error) {
    console.error('Error fetching stories:', error.message);
    return [];
  }
}

// Procesar y enriquecer datos
async function processData() {
  const features = await fetchFeatures();
  const stories = await fetchStories();

  // Agrupar stories por Feature
  const storyPointsByFeature = {};
  const storiesByFeature = {};

  stories.forEach(story => {
    if (story.parentId) {
      if (!storyPointsByFeature[story.parentId]) {
        storyPointsByFeature[story.parentId] = 0;
        storiesByFeature[story.parentId] = [];
      }
      storyPointsByFeature[story.parentId] += story.storyPoints;
      storiesByFeature[story.parentId].push(story);
    }
  });

  // Enriquecer features
  const enrichedFeatures = features.map(feature => {
    const actualSP = storyPointsByFeature[feature.id] || 0;
    const estimatedSprints = feature.estimation.estimatedSprints;
    const sprintCapacity = 48; // Tu capacidad
    const capacityNeeded = estimatedSprints * sprintCapacity;
    
    let risk = 'none';
    
    if (storiesByFeature[feature.id] && storiesByFeature[feature.id].length === 0 && feature.estimation.maxSprintSP > 0) {
      risk = 'no_stories';
    } else if (actualSP === 0 && feature.estimation.maxSprintSP === 0) {
      risk = 'no_estimate';
    } else if (actualSP > capacityNeeded * 0.8) {
      risk = 'at_risk';
    }

    return {
      ...feature,
      actualStoryPoints: actualSP,
      storiesCount: (storiesByFeature[feature.id] || []).length,
      stories: storiesByFeature[feature.id] || [],
      capacityNeeded: capacityNeeded,
      risk: risk
    };
  });

  const riskCounts = {
    none: 0,
    no_stories: 0,
    no_estimate: 0,
    at_risk: 0
  };

  enrichedFeatures.forEach(f => riskCounts[f.risk]++);

  return {
    features: enrichedFeatures,
    summary: {
      total: enrichedFeatures.length,
      risks: riskCounts,
      sprintCapacity: 48,
      timestamp: new Date().toISOString()
    }
  };
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/features', async (req, res) => {
  try {
    const data = await processData();
    res.json(data);
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ADO Sync API running on port ${PORT}`);
});
