require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración
const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;

if (!ADO_ORG || !ADO_PROJECT || !ADO_PAT) {
  console.error('Error: Faltan variables de entorno');
  console.error('ADO_ORG:', ADO_ORG);
  console.error('ADO_PROJECT:', ADO_PROJECT);
  console.error('ADO_PAT:', ADO_PAT ? 'SET' : 'MISSING');
  process.exit(1);
}

// Base64 encode PAT para autenticación
const authHeader = Buffer.from(`:${ADO_PAT}`).toString('base64');

// Cache simple en memoria
let cachedData = null;
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Cliente ADO
const adoClient = axios.create({
  baseURL: `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis`,
  headers: {
    Authorization: `Basic ${authHeader}`,
    'Content-Type': 'application/json'
  }
});

// Obtener Features de ADO
async function fetchFeatures() {
  try {
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      data: {
        query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType]
                FROM workitems
                WHERE [System.WorkItemType] = 'Feature'
                AND [System.AreaPath] UNDER 'Commercial Engineering'`
      }
    });

    const ids = response.data.workItems.map(item => item.id);
    if (ids.length === 0) return [];

    // Obtener detalles de Features
    const detailsResponse = await adoClient.get('/wit/workitemsbatch?api-version=7.0', {
      data: {
        ids: ids,
        fields: ['System.Id', 'System.Title', 'System.State', 'System.TargetDate']
      }
    });

  return detailsResponse.data.value.map(item => {
      return {
        id: item.id,
        title: item.fields['System.Title'],
        state: item.fields['System.State'],
        be: 0,
        fe: 0,
        qa: 0,
        estimated: 0,
        targetDate: item.fields['System.TargetDate'] || '',
        plannedMonth: ''
      };
    });
  } catch (error) {
    console.error('Error fetching features:', error.message);
    throw error;
  }
}

// Obtener User Stories (relacionadas con Features)
async function fetchStories() {
  try {
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      data: {
        query: `SELECT [System.Id], [System.Title], [System.State], [System.Parent], [Microsoft.VSTS.Scheduling.StoryPoints]
                FROM workitems
                WHERE [System.WorkItemType] = 'User Story'
                AND [System.AreaPath] UNDER 'Commercial Engineering'`
      }
    });

    const ids = response.data.workItems.map(item => item.id);
    if (ids.length === 0) return [];

    const detailsResponse = await adoClient.get('/wit/workitemsbatch?api-version=7.0', {
      data: {
        ids: ids,
        fields: ['System.Id', 'System.Title', 'System.State', 'System.Parent', 'Microsoft.VSTS.Scheduling.StoryPoints']
      }
    });

    return detailsResponse.data.value.map(item => ({
      id: item.id,
      title: item.fields['System.Title'],
      state: item.fields['System.State'],
      parentId: item.fields['System.Parent'] || null,
      storyPoints: parseInt(item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0) || 0
    }));
  } catch (error) {
    console.error('Error fetching stories:', error.message);
    throw error;
  }
}

// Procesar datos y calcular métricas
async function processData() {
  const features = await fetchFeatures();
  const stories = await fetchStories();

  // Agrupar stories por Feature
  const storiesByFeature = {};
  const storyPointsByFeature = {};

  stories.forEach(story => {
    if (story.parentId) {
      if (!storiesByFeature[story.parentId]) {
        storiesByFeature[story.parentId] = [];
        storyPointsByFeature[story.parentId] = 0;
      }
      storiesByFeature[story.parentId].push(story);
      storyPointsByFeature[story.parentId] += story.storyPoints;
    }
  });

  // Enriquecer features con métricas
  const enrichedFeatures = features.map(feature => {
    const actual = storyPointsByFeature[feature.id] || 0;
    const delta = actual - feature.estimated;
    let risk = 'none';

    if (feature.estimated === 0 && (storiesByFeature[feature.id] || []).length > 0) {
      risk = 'no_estimate';
    } else if (feature.estimated > 0 && actual === 0) {
      risk = 'no_stories';
    } else if (feature.estimated > 0 && delta > 5) {
      risk = 'overrun';
    } else if (feature.estimated > 0 && actual < feature.estimated * 0.7) {
      risk = 'underestimate';
    }

    return {
      ...feature,
      actual,
      delta,
      storiesCount: (storiesByFeature[feature.id] || []).length,
      stories: storiesByFeature[feature.id] || [],
      risk
    };
  });

  // Calcular resumen
  const riskCounts = {
    none: 0,
    no_estimate: 0,
    no_stories: 0,
    underestimate: 0,
    overrun: 0
  };

  enrichedFeatures.forEach(f => riskCounts[f.risk]++);

  return {
    features: enrichedFeatures,
    summary: {
      total: enrichedFeatures.length,
      risks: riskCounts,
      timestamp: new Date().toISOString()
    }
  };
}

// Endpoints
app.get('/api/features', async (req, res) => {
  try {
    const now = Date.now();
    
    // Verificar cache
    if (cachedData && (now - lastFetch) < CACHE_TTL) {
      return res.json({
        ...cachedData,
        cached: true,
        cacheAge: Math.round((now - lastFetch) / 1000)
      });
    }

    // Fetch nuevo
    const data = await processData();
    cachedData = data;
    lastFetch = now;

    res.json({
      ...data,
      cached: false
    });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/features/:id', async (req, res) => {
  try {
    const data = await processData();
    const feature = data.features.find(f => f.id == req.params.id);
    
    if (!feature) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    res.json(feature);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ADO Sync API running on http://localhost:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET /api/features - Todas las features con métricas`);
  console.log(`  GET /api/features/:id - Feature específica`);
  console.log(`  GET /api/health - Health check`);
});
