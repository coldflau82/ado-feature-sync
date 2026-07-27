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
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= @today - 180'
    });

    console.log('Items found:', r.data.workItems.length);
    const ids = r.data.workItems.map(i => i.id).slice(0, 200);
    
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
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard</title><script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script><script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1400px;margin:0 auto;padding:20px}.header{background:white;padding:20px;margin-bottom:20px;border-radius:8px}.filters{background:white;padding:15px;margin-bottom:20px;display:flex;gap:10px;flex-wrap:wrap}.filter-btn{padding:8px 16px;border:1px solid #ddd;border-radius:4px;background:white;cursor:pointer}.filter-btn.active{background:#007bff;color:white}.filter-btn:hover{border-color:#007bff}table{width:100%;background:white;border-collapse:collapse;margin-top:20px}th,td{padding:12px;text-align:left;border-bottom:1px solid #eee;font-size:13px}a{color:#007bff}</style></head><body><div id="root"><\/div><script type="text/babel">const { useState, useEffect } = React;

function Dashboard() {
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterArea, setFilterArea] = useState('all');

  const allowedAreas = [
    'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online',
    'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print',
    'Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout',
    'Commercial Engineering\\Digital\\Acquisition\\Global Product 1',
    'Commercial Engineering\\Digital\\Acquisition\\Global Product 2',
    'Commercial Engineering\\Digital\\Acquisition\\Global Product 3'
  ];

  useEffect(() => {
    fetch('/api/features')
      .then(r => r.json())
      .then(d => {
        const filtered = (d.features || []).filter(f => allowedAreas.includes(f.areaPath));
        setFeatures(filtered);
        setLoading(false);
      });
  }, []);

  const areas = [...new Set(features.map(f => f.areaPath).filter(a => a))];
  const filtered = filterArea === 'all' ? features : features.filter(f => f.areaPath === filterArea);
  const counts = { all: features.length, ...Object.fromEntries(areas.map(a => [a, features.filter(f => f.areaPath === a).length])) };

  const getAreaName = (path) => {
    if (!path) return 'N/A';
    const parts = path.split('\\\\');
    return parts[parts.length - 1].substring(0, 30);
  };

  const adoLink = (id) => `https://dev.azure.com/tr-commercial-eng/Commercial%20Engineering/_workitems/edit/${id}`;

  return React.createElement('div', { className: 'container' },
    React.createElement('div', { className: 'header' },
      React.createElement('h1', null, 'ADO Features (' + filtered.length + ' de ' + features.length + ')')
    ),

    React.createElement('div', { className: 'filters' },
      React.createElement('button', {
        className: 'filter-btn' + (filterArea === 'all' ? ' active' : ''),
        onClick: () => setFilterArea('all')
      }, 'Todas (' + counts.all + ')'),
      
      areas.map(area =>
        React.createElement('button', {
          key: area,
          className: 'filter-btn' + (filterArea === area ? ' active' : ''),
          onClick: () => setFilterArea(area)
        }, getAreaName(area) + ' (' + counts[area] + ')')
      )
    ),

    loading ? React.createElement('div', null, 'Cargando...') : React.createElement('table', null,
      React.createElement('thead', null,
        React.createElement('tr', null,
          React.createElement('th', null, 'ID'),
          React.createElement('th', null, 'Feature'),
          React.createElement('th', null, 'Area'),
          React.createElement('th', null, 'BE'),
          React.createElement('th', null, 'FE'),
          React.createElement('th', null, 'QA'),
          React.createElement('th', null, 'Estado')
        )
      ),
      React.createElement('tbody', null,
        filtered.map(f =>
          React.createElement('tr', { key: f.id },
            React.createElement('td', null, React.createElement('a', { href: adoLink(f.id), target: '_blank' }, f.id)),
            React.createElement('td', null, f.title.substring(0, 60)),
            React.createElement('td', { style: { fontSize: '11px', color: '#666' } }, getAreaName(f.areaPath)),
            React.createElement('td', null, f.estimation.be || '-'),
            React.createElement('td', null, f.estimation.fe || '-'),
            React.createElement('td', null, f.estimation.qa || '-'),
            React.createElement('td', null, f.state)
          )
        )
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Dashboard));
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
