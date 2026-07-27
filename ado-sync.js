require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: 1 });
});

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

    const ids = r.data.workItems.slice(0, 200).map(i => i.id);
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
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || 'No response data'
    });
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>ADO Dashboard</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
  <style>
    body { font-family: Arial; background: #f5f5f5; margin: 0; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; }
    .header h1 { font-size: 24px; }
    table { width: 100%; background: white; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    a { color: #007bff; text-decoration: none; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;

function Dashboard() {
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterArea, setFilterArea] = useState('all');

  useEffect(() => {
    fetch('/api/features')
      .then(r => r.json())
      .then(d => {
        setFeatures(d.features || []);
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

  return (
    <div className="container">
      <div className="header">
        <h1>ADO Features ({filtered.length} de {features.length})</h1>
      </div>

      <div className="filters">
        <button 
          className={`filter-btn ${filterArea === 'all' ? 'active' : ''}`} 
          onClick={() => setFilterArea('all')}
        >
          Todas ({counts.all})
        </button>
        {areas.map(area => (
          <button
            key={area}
            className={`filter-btn ${filterArea === area ? 'active' : ''}`}
            onClick={() => setFilterArea(area)}
          >
            {getAreaName(area)} ({counts[area]})
          </button>
        ))}
      </div>

      {loading ? <div>Cargando...</div> : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Feature</th>
              <th>Area Path</th>
              <th>BE</th>
              <th>FE</th>
              <th>QA</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(f => (
              <tr key={f.id}>
                <td><a href={adoLink(f.id)} target="_blank">{f.id}</a></td>
                <td>{f.title.substring(0, 60)}</td>
                <td style={{ fontSize: '11px', color: '#666' }}>{getAreaName(f.areaPath)}</td>
                <td>{f.estimation.be || '-'}</td>
                <td>{f.estimation.fe || '-'}</td>
                <td>{f.estimation.qa || '-'}</td>
                <td>{f.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<Dashboard />);
  </script>
</body>
</html>
  `);
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
