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

const authHeader = Buffer.from(`:${ADO_PAT}`).toString('base64');

const adoClient = axios.create({
  baseURL: `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis`,
  headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/json' }
});

function tShirtToSprints(size) {
  const mapping = { 'XS': 1, 'S': 2, 'M': 3, 'L': 4 };
  return mapping[size] || 0;
}

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

    return batch.data.value.map(item => ({
      id: item.id,
      title: item.fields['System.Title'] || '',
      state: item.fields['System.State'] || '',
      targetDate: item.fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
      estimation: {
        be: item.fields['Custom.BEEstimate'] || '',
        fe: item.fields['Custom.FEEstimates'] || '',
        qa: item.fields['Custom.QASizing'] || '',
        estimatedSprints: tShirtToSprints(item.fields['Custom.BEEstimate'] || item.fields['Custom.FEEstimates'] || item.fields['Custom.QASizing'] || 'XS')
      }
    }));
  } catch (error) {
    console.error('Error fetching features:', error.message);
    return [];
  }
}

async function fetchStories() {
  try {
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title], [System.State], [System.Parent], [Microsoft.VSTS.Scheduling.StoryPoints] FROM workitems WHERE [System.WorkItemType] = "User Story"'
    });

    const ids = response.data.workItems.map(item => item.id);
    if (ids.length === 0) return [];

    const batch = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.Parent', 'Microsoft.VSTS.Scheduling.StoryPoints']
    });

    return batch.data.value.map(item => ({
      id: item.id,
      parentId: item.fields['System.Parent'] || null,
      storyPoints: parseInt(item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0) || 0
    }));
  } catch (error) {
    console.error('Error fetching stories:', error.message);
    return [];
  }
}

async function processData() {
  const features = await fetchFeatures();
  const stories = await fetchStories();

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

  const enrichedFeatures = features.map(feature => {
    const actualSP = storyPointsByFeature[feature.id] || 0;
    const estimatedSprints = feature.estimation.estimatedSprints;
    const capacityNeeded = estimatedSprints * 48;
    
    let risk = 'none';
    if (storiesByFeature[feature.id] && storiesByFeature[feature.id].length === 0 && estimatedSprints > 0) {
      risk = 'no_stories';
    } else if (actualSP === 0 && estimatedSprints === 0) {
      risk = 'no_estimate';
    } else if (actualSP > capacityNeeded * 0.8) {
      risk = 'at_risk';
    }

    return { ...feature, actualStoryPoints: actualSP, storiesCount: (storiesByFeature[feature.id] || []).length, capacityNeeded, risk };
  });

  const riskCounts = { none: 0, no_stories: 0, no_estimate: 0, at_risk: 0 };
  enrichedFeatures.forEach(f => riskCounts[f.risk]++);

  return { features: enrichedFeatures, summary: { total: enrichedFeatures.length, risks: riskCounts, timestamp: new Date().toISOString() } };
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Dashboard</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
  <style>
    body { font-family: Arial; background: #f5f5f5; margin: 0; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .metric { background: white; padding: 20px; text-align: center; border-radius: 8px; border-left: 4px solid #007bff; }
    .metric-value { font-size: 32px; font-weight: bold; }
    .loading { text-align: center; padding: 40px; }
    .error { background: #f8d7da; padding: 15px; color: #721c24; border-radius: 4px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;
    
    function Dashboard() {
      const [features, setFeatures] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      
      useEffect(() => {
        fetch('/api/features')
          .then(r => r.json())
          .then(data => {
            setFeatures(data.features || []);
            setLoading(false);
          })
          .catch(err => {
            setError(err.message);
            setLoading(false);
          });
      }, []);
      
      const counts = {
        all: features.length,
        none: features.filter(f => f.risk === 'none').length,
        no_stories: features.filter(f => f.risk === 'no_stories').length,
        at_risk: features.filter(f => f.risk === 'at_risk').length
      };
      
      return (
        <div className="container">
          <div className="header">
            <h1>ADO Features Dashboard</h1>
          </div>
          
          <div className="metrics">
            <div className="metric">
              <div>Total</div>
              <div className="metric-value">{counts.all}</div>
            </div>
            <div className="metric">
              <div>OK</div>
              <div className="metric-value">{counts.none}</div>
            </div>
            <div className="metric">
              <div>Sin Historias</div>
              <div className="metric-value">{counts.no_stories}</div>
            </div>
            <div className="metric">
              <div>En Riesgo</div>
              <div className="metric-value">{counts.at_risk}</div>
            </div>
          </div>
          
          {loading && <div className="loading">Cargando...</div>}
          {error && <div className="error">Error: {error}</div>}
          {!loading && !error && <div><p>Features: {features.length}</p></div>}
        </div>
      );
    }
    
    ReactDOM.createRoot(document.getElementById('root')).render(<Dashboard />);
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
