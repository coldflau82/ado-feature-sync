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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/features', async (req, res) => {
  try {
    const resp = await client.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" ORDER BY [System.ChangedDate] DESC'
    });
    
    const ids = resp.data.workItems.slice(0, 50).map(i => i.id);
    if (ids.length === 0) return res.json({ features: [] });
    
    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });
    
    res.json({
      features: batch.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] || '',
        state: i.fields['System.State'] || '',
        areaPath: i.fields['System.AreaPath'] || '',
        estimation: {
          be: i.fields['Custom.BEEstimate'] || '',
          fe: i.fields['Custom.FEEstimates'] || '',
          qa: i.fields['Custom.QASizing'] || '',
        }
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .metric { background: white; padding: 20px; text-align: center; border-radius: 8px; }
    .metric-value { font-size: 32px; font-weight: bold; color: #007bff; }
    .filters { background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
    .filter-btn { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 13px; }
    .filter-btn.active { background: #007bff; color: white; }
    table { width: 100%; background: white; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
    a { color: #007bff; }
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
          .then(data => {
            setFeatures(data.features || []);
            setLoading(false);
          });
      }, []);
      
      const areas = ['all', ...new Set(features.map(f => f.areaPath).filter(a => a))];
      const filtered = filterArea === 'all' ? features : features.filter(f => f.areaPath === filterArea);
      
      return (
        <div className="container">
          <div className="header">
            <h1>ADO Features Dashboard</h1>
            <p>Total: {features.length}</p>
          </div>
          
          <div className="filters">
            <button className={filterArea === 'all' ? 'filter-btn active' : 'filter-btn'} onClick={() => setFilterArea('all')}>
              Todas ({features.length})
            </button>
            {areas.filter(a => a !== 'all').map(area => (
              <button key={area} className={filterArea === area ? 'filter-btn active' : 'filter-btn'} onClick={() => setFilterArea(area)}>
                {area.split('\\\\').pop().substring(0, 20)} ({features.filter(f => f.areaPath === area).length})
              </button>
            ))}
          </div>
          
          {loading ? <div>Cargando...</div> : (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Feature</th>
                  <th>Area</th>
                  <th>BE</th>
                  <th>FE</th>
                  <th>QA</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(f => (
                  <tr key={f.id}>
                    <td><a href={`https://dev.azure.com/tr-commercial-eng/Commercial%20Engineering/_workitems/edit/${f.id}`} target="_blank">{f.id}</a></td>
                    <td>{f.title.substring(0, 60)}</td>
                    <td style={{fontSize: '11px'}}>{f.areaPath.split('\\\\').pop()}</td>
                    <td>{f.estimation.be || '-'}</td>
                    <td>{f.estimation.fe || '-'}</td>
                    <td>{f.estimation.qa || '-'}</td>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running'));
