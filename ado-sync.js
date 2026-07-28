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
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= @today - 180 AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")'
    });

    const ids = r.data.workItems.map(i => i.id).slice(0, 200);
    if (!ids.length) return res.json({ features: [] });

    const b = await c.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Scheduling.TargetDate', 'Custom.PlannedMonth', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });

    res.json({
      features: b.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] || '',
        state: i.fields['System.State'] || '',
        areaPath: i.fields['System.AreaPath'] || '',
        iterationPath: i.fields['System.IterationPath'] || '',
        priority: i.fields['Microsoft.VSTS.Common.Priority'] || '',
        targetDate: i.fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
        plannedMonth: i.fields['Custom.PlannedMonth'] || '',
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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background: #f5f5f5; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; }
    .header h1 { font-size: 24px; }
    .tabs { margin-top: 15px; display: flex; gap: 10px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
    .tab-btn { padding: 8px 16px; background: white; color: black; border: none; cursor: pointer; border-radius: 4px; font-size: 13px; }
    .tab-btn.active { background: #007bff; color: white; }
    .filters { background: white; padding: 15px; margin-bottom: 20px; border-radius: 8px; display: flex; gap: 10px; flex-wrap: wrap; }
    .filter-btn { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 13px; }
    .filter-btn:hover { border-color: #007bff; }
    .filter-btn.active { background: #007bff; color: white; }
    .table-wrapper { background: white; border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f9f9f9; padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #eee; font-size: 13px; }
    td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
    tr:hover { background: #f5f5f5; }
    a { color: #007bff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div id="root"></div>

  <script type="text/babel">
    const { useState, useEffect } = React;

    function Dashboard() {
      const [features, setFeatures] = useState([]);
      const [loading, setLoading] = useState(true);
      const [filterIteration, setFilterIteration] = useState('all');
      const [currentPage, setCurrentPage] = useState('features');

      useEffect(() => {
        fetch('/api/features')
          .then(r => r.json())
          .then(d => {
            setFeatures(d.features || []);
            setLoading(false);
          });
      }, []);

      const iterations = [...new Set(features.map(f => f.iterationPath).filter(a => a))].sort();
      const filtered = filterIteration === 'all' ? features : features.filter(f => f.iterationPath === filterIteration);
      const counts = { all: features.length, ...Object.fromEntries(iterations.map(a => [a, features.filter(f => f.iterationPath === a).length])) };

      const getIterationName = (path) => {
        if (!path) return 'N/A';
        const parts = path.split('\\\\');
        return parts[parts.length - 1];
      };

      const adoLink = (id) => \`https://dev.azure.com/tr-commercial-eng/Commercial%20Engineering/_workitems/edit/\${id}\`;

      const formatDate = (date) => {
        if (!date) return '-';
        return new Date(date).toLocaleDateString('es-CO');
      };

      return (
        <div className="container">
          <div className="header">
            <h1>ADO Dashboard</h1>
            <div className="tabs">
              <button className={'tab-btn' + (currentPage === 'features' ? ' active' : '')} onClick={() => setCurrentPage('features')}>Feature List</button>
            </div>
          </div>

          {currentPage === 'features' && (
            <>
              <div className="filters">
                <button className={'filter-btn' + (filterIteration === 'all' ? ' active' : '')} onClick={() => setFilterIteration('all')}>Todas ({counts.all})</button>
                {iterations.map(iter => (
                  <button key={iter} className={'filter-btn' + (filterIteration === iter ? ' active' : '')} onClick={() => setFilterIteration(iter)}>
                    {getIterationName(iter)} ({counts[iter]})
                  </button>
                ))}
              </div>

              {loading ? <div>Cargando...</div> : (
                <div className="table-wrapper">
                  <p style={{ padding: '15px', color: '#666', fontSize: '13px' }}>Mostrando {filtered.length} de {features.length}</p>
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Feature</th>
                        <th>Area Path</th>
                        <th>Iteración</th>
                        <th>Prioridad</th>
                        <th>Target Date</th>
                        <th>Planned Month</th>
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
                          <td>{f.title.substring(0, 50)}</td>
                          <td style={{ fontSize: '11px' }}>{f.areaPath.split('\\\\').pop()}</td>
                          <td style={{ fontSize: '11px' }}>{getIterationName(f.iterationPath)}</td>
                          <td>{f.priority || '-'}</td>
                          <td style={{ fontSize: '11px' }}>{formatDate(f.targetDate)}</td>
                          <td>{f.plannedMonth || '-'}</td>
                          <td>{f.estimation.be || '-'}</td>
                          <td>{f.estimation.fe || '-'}</td>
                          <td>{f.estimation.qa || '-'}</td>
                          <td>{f.state}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
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
