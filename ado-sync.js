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

    const baseFilter = 'AND [System.State] <> "Removed" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")';

    const dateRanges = [
      { from: '@today - 30', to: '@today' },
      { from: '@today - 60', to: '@today - 30' },
      { from: '@today - 90', to: '@today - 60' },
      { from: '@today - 180', to: '@today - 90' }
    ];

    let allIds = [];

    for (const range of dateRanges) {
      try {
        const r = await c.post('/wit/wiql?api-version=7.0', {
          query: `SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= ${range.from} AND [System.ChangedDate] < ${range.to} ${baseFilter}`
        });
    
        const ids = r.data.workItems.map(i => i.id);
        console.log(`Range ${range.from} to ${range.to}: ${ids.length} items`);
        allIds = [...allIds, ...ids];
      } catch (e) {
        console.log(`Query range ${range.from} to ${range.to} failed:`, e.message);
      }
    }

    if (!allIds.length) return res.json({ features: [] });

    // Dividir en lotes de 200 para el batch
    const batchSize = 200;
    let allIds = [];
    const rangeCounts = {};

    for (const range of dateRanges) {
      try {
        const r = await c.post('/wit/wiql?api-version=7.0', {
          query: `SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= ${range.from} AND [System.ChangedDate] < ${range.to} ${baseFilter}`
        });
    
        const ids = r.data.workItems.map(i => i.id);
        rangeCounts[`${range.from} to ${range.to}`] = ids.length;
        allIds = [...allIds, ...ids];
      } catch (e) {
        rangeCounts[`${range.from} to ${range.to}`] = 'ERROR: ' + e.message;
      }
    }
    res.json({
      rangeCounts: rangeCounts,
      features: allFeatures.map(i => ({
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
      })),
      total: allFeatures.length
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
      const [filterAreaPath, setFilterAreaPath] = useState([]);
      const [filterIteration, setFilterIteration] = useState([]);
      const [filterState, setFilterState] = useState([]);
      const [filterTargetDate, setFilterTargetDate] = useState([]);
      const [currentPage, setCurrentPage] = useState('features');

      useEffect(() => {
        fetch('/api/features')
          .then(r => r.json())
          .then(d => {
            setFeatures(d.features || []);
            setLoading(false);
          });
      }, []);

      const areaPaths = [...new Set(features.map(f => f.areaPath).filter(a => a))].sort();
      const iterations = [...new Set(features.map(f => f.iterationPath).filter(a => a))].sort();
      const states = [...new Set(features.map(f => f.state).filter(a => a))].sort();
      const targetDates = [...new Set(features.map(f => {
        if (!f.targetDate) return null;
        const date = new Date(f.targetDate);
        return String(date.getFullYear());
      }).filter(a => a))].sort().reverse();

      const filtered = features.filter(f => {
        const areaOk = filterAreaPath.length === 0 || filterAreaPath.includes(f.areaPath);
        const iterOk = filterIteration.length === 0 || filterIteration.includes(f.iterationPath);
        const stateOk = filterState.length === 0 || filterState.includes(f.state);
        let dateOk = filterTargetDate.length === 0;
        if (filterTargetDate.length > 0 && f.targetDate) {
          const year = new Date(f.targetDate).getFullYear();
          dateOk = filterTargetDate.includes(String(year));
        }
        return areaOk && iterOk && stateOk && dateOk;
      });
      
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
    <div className="filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', background: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px', overflowX: 'auto', minHeight: '200px' }}>
  
  <div>
    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px', fontSize: '13px' }}>Area Path</label>
    <select multiple style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '120px' }} onChange={(e) => setFilterAreaPath([...e.target.selectedOptions].map(o => o.value))}>
      {areaPaths.map(area => (
        <option key={area} value={area}>{area.split('\\\\').pop()}</option>
      ))}
    </select>
    {filterAreaPath.length > 0 && <p style={{ fontSize: '11px', color: '#666', marginTop: '5px' }}>{filterAreaPath.length} seleccionados</p>}
  </div>

  <div>
    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px', fontSize: '13px' }}>Iteration Path</label>
    <select multiple style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '120px' }} onChange={(e) => setFilterIteration([...e.target.selectedOptions].map(o => o.value))}>
      {iterations.map(iter => (
        <option key={iter} value={iter}>{iter}</option>
      ))}
    </select>
    {filterIteration.length > 0 && <p style={{ fontSize: '11px', color: '#666', marginTop: '5px' }}>{filterIteration.length} seleccionados</p>}
  </div>

  <div>
    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px', fontSize: '13px' }}>Estado</label>
    <select multiple style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '120px' }} onChange={(e) => setFilterState([...e.target.selectedOptions].map(o => o.value))}>
      {states.map(state => (
        <option key={state} value={state}>{state}</option>
      ))}
    </select>
    {filterState.length > 0 && <p style={{ fontSize: '11px', color: '#666', marginTop: '5px' }}>{filterState.length} seleccionados</p>}
  </div>

  <div>
    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px', fontSize: '13px' }}>Target Date (año)</label>
    <select multiple style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '120px' }} onChange={(e) => setFilterTargetDate([...e.target.selectedOptions].map(o => o.value))}>
      {targetDates.map(year => (
        <option key={year} value={year}>{year}</option>
      ))}
    </select>
    {filterTargetDate.length > 0 && <p style={{ fontSize: '11px', color: '#666', marginTop: '5px' }}>{filterTargetDate.length} seleccionados</p>}
  </div>
</div>

<button style={{ width: '100%', padding: '10px 16px', background: '#dc3545', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', fontSize: '13px', marginBottom: '20px' }} onClick={() => { setFilterAreaPath([]); setFilterIteration([]); setFilterState([]); setFilterTargetDate([]); }}>
  Clean Filters
</button>

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
