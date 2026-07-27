require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: 1 }));

app.get('/api/features', async (req, res) => {
  try {
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        Authorization: `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    const r = await c.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= @today - 180 AND [System.State] <> "Closed" AND [System.State] <> "Removed" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")'
    });

    const ids = r.data.workItems.map(i => i.id).slice(0, 253);
    if (!ids.length) return res.json({ features: [] });

    const b = await c.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });

    res.json({
      features: b.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] || '',
        state: i.fields['System.State'] || '',
        areaPath: i.fields['System.AreaPath'] || '',
        estimation: {
          be: i.fields['Custom.BEEstimate'] || '',
          fe: i.fields['Custom.FEEstimates'] || '',
          qa: i.fields['Custom.QASizing'] || ''
        }
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard</title><script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1400px;margin:0 auto;padding:20px}.header{background:white;padding:20px;margin-bottom:20px;border-radius:8px}.filters{background:white;padding:15px;margin-bottom:20px;display:flex;gap:10px;flex-wrap:wrap}.filter-btn{padding:8px 16px;border:1px solid #ddd;border-radius:4px;background:white;cursor:pointer}.filter-btn.active{background:#007bff;color:white}.filter-btn:hover{border-color:#007bff}table{width:100%;background:white;border-collapse:collapse;margin-top:20px}th,td{padding:12px;text-align:left;border-bottom:1px solid #eee;font-size:13px}a{color:#007bff}</style></head><body><div id="root"><\/div><script type="text/babel">const{useState,useEffect}=React;function D(){const[f,sf]=useState([]);const[l,sl]=useState(true);const[fa,sfa]=useState('all');useEffect(()=>{fetch('/api/features').then(r=>r.json()).then(d=>{sf(d.features||[]);sl(false)})},[]); const areas=[...new Set(f.map(x=>x.areaPath).filter(a=>a))];const filt=fa==='all'?f:f.filter(x=>x.areaPath===fa);const getArea=p=>{if(!p)return'N/A';const parts=p.split('\\\\\\\\');return parts[parts.length-1].substring(0,30)};const link=id=>'https://dev.azure.com/tr-commercial-eng/Commercial%20Engineering/_workitems/edit/'+id;return React.createElement('div',{className:'container'},React.createElement('div',{className:'header'},React.createElement('h1',null,'ADO Features ('+filt.length+' de '+f.length+')')),React.createElement('div',{className:'filters'},React.createElement('button',{className:'filter-btn'+(fa==='all'?' active':''),onClick:()=>sfa('all')},'Todas ('+f.length+')'),areas.map(a=>React.createElement('button',{key:a,className:'filter-btn'+(fa===a?' active':''),onClick:()=>sfa(a)},getArea(a)+' ('+f.filter(x=>x.areaPath===a).length+')'))),l?React.createElement('div',null,'Cargando...'):React.createElement('table',null,React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'ID'),React.createElement('th',null,'Feature'),React.createElement('th',null,'Area'),React.createElement('th',null,'BE'),React.createElement('th',null,'FE'),React.createElement('th',null,'QA'),React.createElement('th',null,'Estado'))),React.createElement('tbody',null,filt.map(x=>React.createElement('tr',{key:x.id},React.createElement('td',null,React.createElement('a',{href:link(x.id),target:'_blank'},x.id)),React.createElement('td',null,x.title.substring(0,60)),React.createElement('td',{style:{fontSize:'11px',color:'#666'}},getArea(x.areaPath)),React.createElement('td',null,x.estimation.be||'-'),React.createElement('td',null,x.estimation.fe||'-'),React.createElement('td',null,x.estimation.qa||'-'),React.createElement('td',null,x.state))))))}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(D))<\/script></body></html>`);
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
