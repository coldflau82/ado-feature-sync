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
    const sprintCapacity = 48;
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

// RUTAS
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

// Dashboard
app.get('/dashboard', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADO Features Dashboard</title>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header h1 { font-size: 28px; margin-bottom: 5px; }
    .header p { color: #666; font-size: 14px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .metric-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; border-left: 4px solid #007bff; }
    .metric-card.ok { border-left-color: #28a745; }
    .metric-card.warning { border-left-color: #ffc107; }
    .metric-card.danger { border-left-color: #dc3545; }
    .metric-value { font-size: 32px; font-weight: bold; color: #007bff; margin: 10px 0; }
    .metric-label { font-size: 12px; color: #666; text-transform: uppercase; }
    .filters { background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; gap: 10px; flex-wrap: wrap; }
    .filter-btn { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 13px; }
    .filter-btn:hover { border-color: #007bff; color: #007bff; }
    .filter-btn.active { background: #007bff; color: white; border-color: #007bff; }
    .table-container { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f9f9f9; padding: 15px; text-align: left; font-weight: 600; color: #666; border-bottom: 2px solid #eee; }
    td { padding: 15px; border-bottom: 1px solid #eee; }
    tr:hover { background: #f9f9f9; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge.ok { background: #d4edda; color: #155724; }
    .badge.warning { background: #fff3cd; color: #856404; }
    .badge.danger { background: #f8d7da; color: #721c24; }
    .loading { text-align: center; padding: 40px; color: #666; }
    .error { background: #f8d7da; color: #721c24; padding: 15px; border-radius: 4px; margin: 20px 0; }
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
      const [filterRisk, setFilterRisk] = useState('all');

      useEffect(() => {
        loadFeatures();
      }, []);

      async function loadFeatures() {
        try {
          setLoading(true);
          const response = await fetch('/api/features');
          
          if (!response.ok) {
            throw new Error(\`Error \${response.status}\`);
          }
          
          const data = await response.json();
          setFeatures(data.features || []);
          setError(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }

      const filteredFeatures = filterRisk === 'all' ? features : features.filter(f => f.risk === filterRisk);
      const riskCounts = {
        all: features.length,
        none: features.filter(f => f.risk === 'none').length,
        no_stories: features.filter(f => f.risk === 'no_stories').length,
        at_risk: features.filter(f => f.risk === 'at_risk').length
      };

      function getRiskClass(risk) {
        if (risk === 'none') return 'ok';
        if (risk === 'no_stories' || risk === 'at_risk') return 'danger';
        return 'warning';
      }

      function getRiskLabel(risk) {
        const labels = { 'none': '✓ OK', 'no_stories': '🔴 Sin Historias', 'no_estimate': '⚠ Sin Est.', 'at_risk': '📈 En Riesgo' };
        return labels[risk] || risk;
      }

      return (
        <div className="container">
          <div className="header">
            <h1>ADO Features Dashboard</h1>
            <p>Monitoreo de Features, Estimaciones y Capacidad</p>
          </div>

          <div className="metrics">
            <div className="metric-card ok"><div className="metric-label">Total</div><div className="metric-value">{riskCounts.all}</div></div>
            <div className="metric-card ok"><div className="metric-label">OK</div><div className="metric-value">{riskCounts.none}</div></div>
            <div className="metric-card danger"><div className="metric-label">Sin Historias</div><div className="metric-value">{riskCounts.no_stories}</div></div>
            <div className="metric-card warning"><div className="metric-label">En Riesgo</div><div className="metric-value">{riskCounts.at_risk}</div></div>
          </div>

          <div className="filters">
            <button className={\`filter-btn \${filterRisk === 'all' ? 'active' : ''}\`} onClick={() => setFilterRisk('all')}>Todas ({riskCounts.all})</button>
            <button className={\`filter-btn \${filterRisk === 'none' ? 'active' : ''}\`} onClick={() => setFilterRisk('none')}>OK ({riskCounts.none})</button>
            <button className={\`filter-btn \${filterRisk === 'no_stories' ? 'active' : ''}\`} onClick={() => setFilterRisk('no_stories')}>Sin Historias ({riskCounts.no_stories})</button>
            <button className={\`filter-btn \${filterRisk === 'at_risk' ? 'active' : ''}\`} onClick={() => setFilterRisk('at_risk')}>En Riesgo ({riskCounts.at_risk})</button>
            <button className="filter-btn" onClick={loadFeatures} style={{marginLeft: 'auto'}}>🔄 Actualizar</button>
          </div>

          {loading && <div className="loading">Cargando...</div>}
          {error && <div className="error">Error: {error}</div>}

          {!loading && !error && <div className="table-container"><table><thead><tr><th>Feature</th><th>Estado</th><th>BE</th><th>FE</th><th>QA</th><th>Story Points</th><th>Sprints</th><th>Riesgo</th></tr></thead><tbody>{filteredFeatures.map(f => (<tr key={f.id}><td><strong>{f.title.substring(0, 50)}</strong><br/><span style={{color: '#999', fontSize: '11px'}}>ID: {f.id}</span></td><td>{f.state}</td><td>{f.estimation.be || '-'}</td><td>{f.estimation.fe || '-'}</td><td>{f.estimation.qa || '-'}</td><td><strong>{f.actualStoryPoints}</strong></td><td>{f.estimation.estimatedSprints}</td><td><span className={\`badge \${getRiskClass(f.risk)}\`}>{getRiskLabel(f.risk)}</span></td></tr>))}</tbody></table></div>}
        </div>
      );
    }

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<Dashboard />);
  <\/script>
</body>
</html>`;
  
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
