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

const areaFilters = [
  'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online',
  'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print',
  'Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout',
  'Commercial Engineering\\Digital\\Acquisition\\Global Product 1',
  'Commercial Engineering\\Digital\\Acquisition\\Global Product 2',
  'Commercial Engineering\\Digital\\Acquisition\\Global Product 3'
];

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/features', async (req, res) => {
  try {
    const resp = await client.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title], [System.AreaPath], [System.State] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.State] = "In Process" AND [System.ChangedDate] >= @today - 90'
    });
    
    // Log para debuggear
console.log('Total items:', resp.data.workItems.length);
console.log('First item:', JSON.stringify(resp.data.workItems[0], null, 2));

const filtered = resp.data.workItems.slice(0, 200); // Sin filtro por ahora
console.log('Filtered:', filtered.length);
    
    const ids = filtered.map(i => i.id);
    if (ids.length === 0) return res.json({ features: [], summary: { total: 0 } });
    
    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });
    
    res.json({
      features: batch.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] || '',
        state: i.fields['System.State'] || '',
        estimation: {
          be: i.fields['Custom.BEEstimate'] || '',
          fe: i.fields['Custom.FEEstimates'] || '',
          qa: i.fields['Custom.QASizing'] || '',
          estimatedSprints: 0
        },
        actualStoryPoints: 0,
        risk: 'unknown'
      })),
      summary: { total: batch.data.value.length }
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard</title><script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1200px;margin:0 auto;padding:20px}.header{background:#fff;padding:20px;margin-bottom:20px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px}.metric{background:#fff;padding:20px;text-align:center}.metric-value{font-size:32px;font-weight:bold;color:#007bff}table{width:100%;background:#fff;margin-top:20px}.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:bold}.badge-ok{background:#d4edda;color:#155724}.badge-danger{background:#f8d7da;color:#721c24}</style></head><body><div id="root"><\/div><script type="text/babel">const{useState,useEffect}=React;function D(){const[f,sf]=useState([]);const[l,sl]=useState(true);useEffect(()=>{fetch('/api/features').then(r=>r.json()).then(d=>{sf(d.features||[]);sl(false)})},[]); const c={all:f.length,ok:f.filter(x=>x.risk==='none').length,no:f.filter(x=>x.risk==='no_stories').length};return React.createElement('div',{className:'container'},React.createElement('div',{className:'header'},React.createElement('h1',null,'ADO Features')),React.createElement('div',{className:'metrics'},React.createElement('div',{className:'metric'},React.createElement('div',null,'Total'),React.createElement('div',{className:'metric-value'},c.all)),React.createElement('div',{className:'metric'},React.createElement('div',null,'OK'),React.createElement('div',{className:'metric-value'},c.ok)),React.createElement('div',{className:'metric'},React.createElement('div',null,'Sin Historias'),React.createElement('div',{className:'metric-value'},c.no))),l?React.createElement('div',null,'Cargando...'):React.createElement('table',null,React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'Feature'),React.createElement('th',null,'BE'),React.createElement('th',null,'FE'),React.createElement('th',null,'QA'),React.createElement('th',null,'Riesgo'))),React.createElement('tbody',null,f.map(x=>React.createElement('tr',{key:x.id},React.createElement('td',null,x.title.substring(0,50)),React.createElement('td',null,x.estimation.be||'-'),React.createElement('td',null,x.estimation.fe||'-'),React.createElement('td',null,x.estimation.qa||'-'),React.createElement('td',null,React.createElement('span',{className:x.risk==='none'?'badge badge-ok':'badge badge-danger'},x.risk))))))))}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(D))<\/script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running'));
