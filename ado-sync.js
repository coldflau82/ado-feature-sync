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
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADO Dashboard</title><script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f5f5f5;color:#333}.container{max-width:1400px;margin:0 auto;padding:20px}.header{background:#fff;padding:20px;border-radius:8px;margin-bottom:20px}.header h1{font-size:28px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:20px}.metric-card{background:#fff;padding:20px;border-radius:8px;border-left:4px solid #007bff;text-align:center}.metric-card.ok{border-left-color:#28a745}.metric-card.danger{border-left-color:#dc3545}.metric-value{font-size:32px;font-weight:bold;margin:10px 0}.filters{background:#fff;padding:15px;border-radius:8px;margin-bottom:20px;display:flex;gap:10px;flex-wrap:wrap}.filter-btn{padding:8px 16px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:13px}.filter-btn:hover{border-color:#007bff}.filter-btn.active{background:#007bff;color:#fff}.table-container{background:#fff;border-radius:8px;overflow:hidden}table{width:100%;font-size:13px}th{background:#f9f9f9;padding:15px;text-align:left;font-weight:600;border-bottom:2px solid #eee}td{padding:15px;border-bottom:1px solid #eee}.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600}.badge.ok{background:#d4edda;color:#155724}.badge.danger{background:#f8d7da;color:#721c24}.loading{text-align:center;padding:40px;color:#666}.error{background:#f8d7da;color:#721c24;padding:15px;border-radius:4px}</style></head><body><div id="root"><\/div><script type="text/babel">const{useState,useEffect}=React;function Dashboard(){const[features,setFeatures]=useState([]);const[loading,setLoading]=useState(true);const[error,setError]=useState(null);const[filterRisk,setFilterRisk]=useState('all');useEffect(()=>{loadFeatures()},[]);async function loadFeatures(){try{setLoading(true);const response=await fetch('/api/features');if(!response.ok)throw new Error('Error '+response.status);const data=await response.json();setFeatures(data.features||[]);setError(null)}catch(err){setError(err.message)}finally{setLoading(false)}}const filtered=filterRisk==='all'?features:features.filter(f=>f.risk===filterRisk);const counts={all:features.length,none:features.filter(f=>f.risk==='none').length,no_stories:features.filter(f=>f.risk==='no_stories').length,at_risk:features.filter(f=>f.risk==='at_risk').length};function getRiskClass(risk){return risk==='none'?'ok':'danger'}function getRiskLabel(risk){const l={'none':'✓ OK','no_stories':'🔴 Sin Historias','no_estimate':'⚠ Sin Est.','at_risk':'📈 En Riesgo'};return l[risk]||risk}return React.createElement('div',{className:'container'},React.createElement('div',{className:'header'},React.createElement('h1',null,'ADO Features Dashboard')),React.createElement('div',{className:'metrics'},React.createElement('div',{className:'metric-card ok'},React.createElement('div',null,'Total'),React.createElement('div',{className:'metric-value'},counts.all)),React.createElement('div',{className:'metric-card ok'},React.createElement('div',null,'OK'),React.createElement('div',{className:'metric-value'},counts.none)),React.createElement('div',{className:'metric-card danger'},React.createElement('div',null,'Sin Historias'),React.createElement('div',{className:'metric-value'},counts.no_stories)),React.createElement('div',{className:'metric-card danger'},React.createElement('div',null,'En Riesgo'),React.createElement('div',{className:'metric-value'},counts.at_risk))),React.createElement('div',{className:'filters'},React.createElement('button',{className:'filter-btn '+(filterRisk==='all'?'active':''),onClick:()=>setFilterRisk('all')},'Todas ('+counts.all+')'),React.createElement('button',{className:'filter-btn '+(filterRisk==='none'?'active':''),onClick:()=>setFilterRisk('none')},'OK ('+counts.none+')'),React.createElement('button',{className:'filter-btn '+(filterRisk==='no_stories'?'active':''),onClick:()=>setFilterRisk('no_stories')},'Sin Historias ('+counts.no_stories+')'),React.createElement('button',{className:'filter-btn '+(filterRisk==='at_risk'?'active':''),onClick:()=>setFilterRisk('at_risk')},'En Riesgo ('+counts.at_risk+')'),React.createElement('button',{className:'filter-btn',onClick:loadFeatures,style:{marginLeft:'auto'}},'🔄 Actualizar')),loading&&React.createElement('div',{className:'loading'},'Cargando...'),error&&React.createElement('div',{className:'error'},'Error: '+error),!loading&&!error&&React.createElement('div',{className:'table-container'},React.createElement('table',null,React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'Feature'),React.createElement('th',null,'Estado'),React.createElement('th',null,'BE'),React.createElement('th',null,'FE'),React.createElement('th',null,'QA'),React.createElement('th',null,'SP Reales'),React.createElement('th',null,'Sprints'),React.createElement('th',null,'Riesgo'))),React.createElement('tbody',null,filtered.map(f=>React.createElement('tr',{key:f.id},React.createElement('td',null,React.createElement('strong',null,f.title.substring(0,50)),React.createElement('br',null),React.createElement('span',{style:{color:'#999',fontSize:'11px'}},'ID: '+f.id)),React.createElement('td',null,f.state),React.createElement('td',null,f.estimation.be||'-'),React.createElement('td',null,f.estimation.fe||'-'),React.createElement('td',null,f.estimation.qa||'-'),React.createElement('td',null,React.createElement('strong',null,f.actualStoryPoints)),React.createElement('td',null,f.estimation.estimatedSprints),React.createElement('td',null,React.createElement('span',{className:'badge '+getRiskClass(f.risk)},getRiskLabel(f.risk))))))))))}const root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(Dashboard))<\/script></body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
