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
  const response = await adoClient.post('/wit/wiql?api-version=7.0', {
    query: 'SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.WorkItemType] = "Feature" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3") AND [System.State] = "In Process" AND [System.ChangedDate] >= @today - 90'
  });

  const ids = response.data.workItems.map(item => item.id);
  if (ids.length === 0) return [];

  const batch = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
    ids: ids,
    fields: ['System.Id', 'System.Title', 'System.State', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
  });

  return batch.data.value.map(item => ({
    id: item.id,
    title: item.fields['System.Title'] || '',
    state: item.fields['System.State'] || '',
    estimation: {
      be: item.fields['Custom.BEEstimate'] || '',
      fe: item.fields['Custom.FEEstimates'] || '',
      qa: item.fields['Custom.QASizing'] || '',
      estimatedSprints: tShirtToSprints(item.fields['Custom.BEEstimate'] || item.fields['Custom.FEEstimates'] || item.fields['Custom.QASizing'] || 'XS')
    }
  }));
}

async function fetchStories() {
  const response = await adoClient.post('/wit/wiql?api-version=7.0', {
    query: 'SELECT [System.Id], [System.Title], [System.Parent], [Microsoft.VSTS.Scheduling.StoryPoints] FROM workitems WHERE [System.WorkItemType] = "User Story"'
  });

  const ids = response.data.workItems.map(item => item.id);
  if (ids.length === 0) return [];

  const batch = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
    ids: ids,
    fields: ['System.Id', 'System.Parent', 'Microsoft.VSTS.Scheduling.StoryPoints']
  });

  return batch.data.value.map(item => ({
    parentId: item.fields['System.Parent'] || null,
    storyPoints: parseInt(item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0) || 0
  }));
}

async function processData() {
  const features = await fetchFeatures();
  const stories = await fetchStories();

  const storyPointsByFeature = {};
  stories.forEach(story => {
    if (story.parentId) {
      storyPointsByFeature[story.parentId] = (storyPointsByFeature[story.parentId] || 0) + story.storyPoints;
    }
  });

  const enrichedFeatures = features.map(feature => {
    const actualSP = storyPointsByFeature[feature.id] || 0;
    const estimatedSprints = feature.estimation.estimatedSprints;
    let risk = 'none';
    if (actualSP === 0 && estimatedSprints > 0) risk = 'no_stories';
    if (actualSP === 0 && estimatedSprints === 0) risk = 'no_estimate';
    if (actualSP > estimatedSprints * 48 * 0.8) risk = 'at_risk';
    return { ...feature, actualStoryPoints: actualSP, risk };
  });

  const riskCounts = { none: 0, no_stories: 0, no_estimate: 0, at_risk: 0 };
  enrichedFeatures.forEach(f => riskCounts[f.risk]++);

  return { features: enrichedFeatures, summary: { total: enrichedFeatures.length, risks: riskCounts } };
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/features', async (req, res) => {
  try {
    const data = await processData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard</title><script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1200px;margin:0 auto;padding:20px}.header{background:white;padding:20px;margin-bottom:20px;border-radius:8px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:20px}.metric{background:white;padding:20px;text-align:center;border-radius:8px}.metric-value{font-size:32px;font-weight:bold;color:#007bff}.loading{text-align:center;padding:40px}.error{background:#f8d7da;padding:15px;color:#721c24;border-radius:4px}table{width:100%;background:white;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid #eee}.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:bold}.badge-ok{background:#d4edda;color:#155724}.badge-danger{background:#f8d7da;color:#721c24}</style></head><body><div id="root"><\/div><script type="text/babel">const{useState,useEffect}=React;function D(){const[f,sf]=useState([]);const[l,sl]=useState(true);const[e,se]=useState(null);useEffect(()=>{fetch('/api/features').then(r=>r.json()).then(d=>{sf(d.features||[]);sl(false)}).catch(er=>{se(er.message);sl(false)})},[]); const c={all:f.length,ok:f.filter(x=>x.risk==='none').length,no:f.filter(x=>x.risk==='no_stories').length,risk:f.filter(x=>x.risk==='at_risk').length};return React.createElement('div',{className:'container'},React.createElement('div',{className:'header'},React.createElement('h1',null,'Dashboard')),React.createElement('div',{className:'metrics'},React.createElement('div',{className:'metric'},React.createElement('div',null,'Total'),React.createElement('div',{className:'metric-value'},c.all)),React.createElement('div',{className:'metric'},React.createElement('div',null,'OK'),React.createElement('div',{className:'metric-value'},c.ok)),React.createElement('div',{className:'metric'},React.createElement('div',null,'Sin Historias'),React.createElement('div',{className:'metric-value'},c.no)),React.createElement('div',{className:'metric'},React.createElement('div',null,'En Riesgo'),React.createElement('div',{className:'metric-value'},c.risk))),l&&React.createElement('div',{className:'loading'},'Cargando...'),e&&React.createElement('div',{className:'error'},'Error: '+e),!l&&!e&&React.createElement('div',null,React.createElement('table',null,React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'Feature'),React.createElement('th',null,'BE'),React.createElement('th',null,'FE'),React.createElement('th',null,'QA'),React.createElement('th',null,'SP'),React.createElement('th',null,'Riesgo'))),React.createElement('tbody',null,f.map(x=>React.createElement('tr',{key:x.id},React.createElement('td',null,x.title.substring(0,40)),React.createElement('td',null,x.estimation.be||'-'),React.createElement('td',null,x.estimation.fe||'-'),React.createElement('td',null,x.estimation.qa||'-'),React.createElement('td',null,x.actualStoryPoints),React.createElement('td',null,React.createElement('span',{className:x.risk==='none'?'badge badge-ok':'badge badge-danger'},x.risk))))))))}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(D))<\/script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
