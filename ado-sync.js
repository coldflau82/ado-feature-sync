require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
const client = axios.create({
  baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
  headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/json' }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/features', async (req, res) => {
  try {
    const resp = await client.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature"'
    });
    
    const ids = resp.data.workItems.slice(0, 100).map(i => i.id);
    if (!ids.length) return res.json({ features: [] });
    
    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });
    
    res.json({
      features: batch.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] || '',
        state: i.fields['System.State'] || '',
        estimation: { be: i.fields['Custom.BEEstimate'] || '', fe: i.fields['Custom.FEEstimates'] || '', qa: i.fields['Custom.QASizing'] || '' },
        risk: 'unknown'
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard</title><script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1400px;margin:0 auto;padding:20px}.header{background:white;padding:20px;margin-bottom:20px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:20px}.metric{background:white;padding:20px;text-align:center}.metric-value{font-size:32px;font-weight:bold;color:#007bff}table{width:100%;background:white;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid #eee;font-size:13px}a{color:#007bff}</style></head><body><div id="root"><\/div><script type="text/babel">const{useState,useEffect}=React;function D(){const[f,sf]=useState([]);const[l,sl]=useState(true);useEffect(()=>{fetch('/api/features').then(r=>r.json()).then(d=>{sf(d.features||[]);sl(false)})},[]); return React.createElement('div',{className:'container'},React.createElement('div',{className:'header'},React.createElement('h1',null,'Dashboard'),React.createElement('p',null,'Features: '+f.length)),l?React.createElement('div',null,'Cargando...'):React.createElement('table',null,React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'ID'),React.createElement('th',null,'Feature'),React.createElement('th',null,'BE'),React.createElement('th',null,'FE'),React.createElement('th',null,'QA'))),React.createElement('tbody',null,f.map(x=>React.createElement('tr',{key:x.id},React.createElement('td',null,React.createElement('a',{href:'https://dev.azure.com/tr-commercial-eng/Commercial%20Engineering/_workitems/edit/'+x.id,target:'_blank'},x.id)),React.createElement('td',null,x.title.substring(0,50)),React.createElement('td',null,x.estimation.be||'-'),React.createElement('td',null,x.estimation.fe||'-'),React.createElement('td',null,x.estimation.qa||'-'))))))}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(D))<\/script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server ok'));
