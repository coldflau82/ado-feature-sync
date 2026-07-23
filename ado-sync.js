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
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .metric { background: white; padding: 20px; text-align: center; border-radius: 8px; }
    .metric-value { font-size: 32px; font-weight: bold; color: #007bff; }
    table { width: 100%; background: white; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;
    
    function Dashboard() {
      const [features, setFeatures] = useState([]);
      const [loading, setLoading] = useState(true);
      
      useEffect(() => {
        fetch('/api/features')
          .then(r => r.json())
          .then(data => {
            setFeatures(data.features || []);
            setLoading(false);
          });
      }, []);
      
      const total = features.length;
      const ok = features.filter(f => f.risk === 'none').length;
      const noStories = features.filter(f => f.risk === 'no_stories').length;
      
      return (
        <div className="container">
          <div className="header">
            <h1>ADO Features Dashboard</h1>
          </div>
          
          <div className="metrics">
            <div className="metric">
              <div>Total</div>
              <div className="metric-value">{total}</div>
            </div>
            <div className="metric">
              <div>OK</div>
              <div className="metric-value">{ok}</div>
            </div>
            <div className="metric">
              <div>Sin Historias</div>
              <div className="metric-value">{noStories}</div>
            </div>
          </div>
          
          {loading ? (
            <div>Cargando...</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>BE</th>
                  <th>FE</th>
                  <th>QA</th>
                  <th>Riesgo</th>
                </tr>
              </thead>
              <tbody>
                {features.map(f => (
                  <tr key={f.id}>
                    <td>{f.title.substring(0, 50)}</td>
                    <td>{f.estimation.be || '-'}</td>
                    <td>{f.estimation.fe || '-'}</td>
                    <td>{f.estimation.qa || '-'}</td>
                    <td>{f.risk}</td>
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
