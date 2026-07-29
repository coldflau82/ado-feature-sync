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
      { from: '@today - 10', to: '@today' },
      { from: '@today - 20', to: '@today - 10' },
      { from: '@today - 30', to: '@today - 20' },
      { from: '@today - 60', to: '@today - 30' },
      { from: '@today - 90', to: '@today - 60' },
      { from: '@today - 180', to: '@today - 90' }
    ];

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

    if (!allIds.length) return res.json({ features: [] });

    const batchSize = 200;
    let allFeatures = [];

    for (let i = 0; i < allIds.length; i += batchSize) {
      const batch = await c.post('/wit/workitemsbatch?api-version=7.0', {
        ids: allIds.slice(i, i + batchSize),
        fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Scheduling.TargetDate', 'Custom.PlannedMonth', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
      });

      allFeatures = [...allFeatures, ...batch.data.value];
    }

    // Obtener User Stories
    const storiesByFeature = {};
    let totalStoriesFound = 0;
    let storyDebug = null;

    try {
      const storyQuery = `SELECT [System.Id] FROM workitems
WHERE
    [System.TeamProject] = 'Commercial Engineering'
    AND [System.ChangedDate] > @today - 180
    AND [System.WorkItemType] = 'User Story'
    AND (
        [System.AreaPath] = 'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online'
        OR [System.AreaPath] = 'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print'
        OR [System.AreaPath] = 'Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout'
        OR [System.AreaPath] = 'Commercial Engineering\\Digital\\Acquisition\\Global Product 1'
        OR [System.AreaPath] = 'Commercial Engineering\\Digital\\Acquisition\\Global Product 2'
        OR [System.AreaPath] = 'Commercial Engineering\\Digital\\Acquisition\\Global Product 3'
    )
    AND (
        [System.State] <> 'Closed'
        AND [System.State] <> 'Resolved'
        AND [System.State] <> 'Removed'
    )`;

      const storyResponse = await c.post('/wit/wiql?api-version=7.0', {
        query: storyQuery
      });

      const storyIds = storyResponse.data.workItems.map(i => i.id);
      storyDebug = { queriedStories: storyIds.length };

      if (storyIds.length > 0) {
        const storyBatchSize = 200;
        for (let i = 0; i < storyIds.length; i += storyBatchSize) {
          const storyBatch = await c.post('/wit/workitemsbatch?api-version=7.0', {
            ids: storyIds.slice(i, i + storyBatchSize),
            fields: ['System.Id', 'System.Title', 'System.Parent', 'Microsoft.VSTS.Scheduling.StoryPoints', 'System.State']
          });

          storyBatch.data.value.forEach(story => {
            const parentId = story.fields['System.Parent'];
            if (parentId) {
              if (!storiesByFeature[parentId]) {
                storiesByFeature[parentId] = [];
              }
              storiesByFeature[parentId].push({
                id: story.id,
                title: story.fields['System.Title'] || '',
                storyPoints: story.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0,
                state: story.fields['System.State'] || ''
              });
              totalStoriesFound++;
            }
          });
        }
      }
    } catch (e) {
      storyDebug = { error: e.message };
    }

    const warnings = [];
    for (const [range, count] of Object.entries(rangeCounts)) {
      if (typeof count === 'number' && count >= 200) {
        warnings.push(`WARNING: Range "${range}" has ${count} items - DATA MAY BE MISSING`);
      }
    }

    res.json({
      rangeCounts: rangeCounts,
      warnings: warnings,
      storyDebug: storyDebug,
      total: allFeatures.length,
      totalStories: totalStoriesFound,
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
        },
        stories: storiesByFeature[i.id] || []
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
    .warnings { background: #fff3cd; color: '#856404'; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffc107; }
    .filters { display: grid; gridTemplateColumns: 'repeat(4, 1fr)'; gap: 15px; background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; overflow-x: auto; }
    .filter-div { }
    .filter-label { display: block; font-weight: bold; margin-bottom: 8px; font-size: 13px; }
    .filter-select { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; min-height: 120px; }
    .filter-count { font-size: 11px; color: #666; margin-top: 5px; }
    .clear-btn { width: 100%; padding: 10px 16px; background: #dc3545; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; font-size: 13px; margin-bottom: 20px; }
    .table-wrapper { background: white; border-radius: 8px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f9f9f9; padding: 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #eee; font-size: 13px; }
    td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
    tr:hover { background: #f5f5f5; }
    a { color: #007bff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .expand-btn { cursor: pointer; user-select: none; text-align: center; width: 30px; }
  </style>
</head>
<body>
  <div id="root"></div>

  <script type="text/babel">
    const { useState, useEffect } = React;

    function Dashboard() {
      const [features, setFeatures] = useState([]);
      const [loading, setLoading] = useState(true);
      const [warnings, setWarnings] = useState([]);
      const [filterAreaPath, setFilterAreaPath] = useState([]);
      const [filterIteration, setFilterIteration] = useState([]);
      const [currentPage, setCurrentPage] = useState('features');
      const [expandedRows, setExpandedRows] = useState({});
      const [searchTitle, setSearchTitle] = useState('');
      const [sortColumn, setSortColumn] = useState('id');
      const [sortOrder, setSortOrder] = useState('asc');
      const currentYear = String(new Date().getFullYear());
      const [filterState, setFilterState] = useState([]);
      const [filterTargetDate, setFilterTargetDate] = useState([currentYear]);

      useEffect(() => {
        fetch('/api/features')
          .then(r => r.json())
          .then(d => {
            setFeatures(d.features || []);
            setWarnings(d.warnings || []);
            setLoading(false);
      
            // Preseleccionar estados (todos menos "Closed")
            const allStates = [...new Set((d.features || []).map(f => f.state).filter(a => a))].sort();
            const statesWithoutClosed = allStates.filter(s => s !== 'Closed');
          setFilterState(statesWithoutClosed);
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
          const searchOk = searchTitle === '' || f.title.toLowerCase().includes(searchTitle.toLowerCase());
          return areaOk && iterOk && stateOk && dateOk && searchOk;
        });

        // Ordenar features
          let sortedFiltered = [...filtered];
          if (sortColumn) {
            sortedFiltered.sort((a, b) => {
              let valA = '', valB = '';
              
              if (sortColumn === 'id') { 
                valA = a.id; 
                valB = b.id; 
              }
              else if (sortColumn === 'title') { 
                valA = (a.title || '').toLowerCase(); 
                valB = (b.title || '').toLowerCase(); 
              }
              else if (sortColumn === 'areaPath') { 
                valA = (a.areaPath || '').toLowerCase(); 
                valB = (b.areaPath || '').toLowerCase(); 
              }
              else if (sortColumn === 'iteration') { 
                valA = (a.iterationPath || '').toLowerCase(); 
                valB = (b.iterationPath || '').toLowerCase(); 
              }
              else if (sortColumn === 'priority') { 
                valA = parseInt(a.priority) || 0; 
                valB = parseInt(b.priority) || 0; 
              }
              else if (sortColumn === 'state') { 
                valA = (a.state || '').toLowerCase(); 
                valB = (b.state || '').toLowerCase(); 
              }
              else if (sortColumn === 'targetDate') { 
                valA = (a.targetDate || ''); 
                valB = (b.targetDate || ''); 
              }
              
              if (sortOrder === 'asc') {
                return valA < valB ? -1 : valA > valB ? 1 : 0;
              } else {
                return valA > valB ? -1 : valA < valB ? 1 : 0;
              }
            });
          }

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
              <button className={'tab-btn' + (currentPage === 'roadmap' ? ' active' : '')} onClick={() => setCurrentPage('roadmap')}>Roadmap</button>
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="warnings">
              <strong>⚠️ Data Warnings:</strong>
              {warnings.map((w, i) => <div key={i} style={{ fontSize: '13px', marginTop: '5px' }}>{w}</div>)}
            </div>
          )}

          {currentPage === 'features' && (
            <>
              <div style={{ background: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px', display: 'flex', gap: '15px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px', fontSize: '13px' }}>Search Feature Title</label>
                  <input 
                    type="text" 
                    placeholder="Type feature title..." 
                    value={searchTitle}
                    onChange={(e) => setSearchTitle(e.target.value)}
                    style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px' }}
                  />
                </div>
                <button style={{ padding: '10px 20px', background: '#dc3545', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap' }} onClick={() => { setFilterAreaPath([]); setFilterIteration([]); setFilterState([]); setFilterTargetDate([]); }}>
                  Clear filters
                </button>
              </div>

              <div className="filters" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: '15px', background: 'white', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
                
                <div>
                  <label className="filter-label">Area Path</label>
                  <select multiple className="filter-select" value={filterAreaPath} onChange={(e) => setFilterAreaPath([...e.target.selectedOptions].map(o => o.value))}>
                    {areaPaths.map(area => (
                      <option key={area} value={area}>{area.split('\\\\').pop()}</option>
                    ))}
                  </select>
                  {filterAreaPath.length > 0 && <p className="filter-count">{filterAreaPath.length} selected</p>}
                </div>

                <div>
                  <label className="filter-label">Iteration Path</label>
                  <select multiple className="filter-select" value={filterIteration} onChange={(e) => setFilterIteration([...e.target.selectedOptions].map(o => o.value))}>
                    {iterations.map(iter => (
                      <option key={iter} value={iter}>{iter}</option>
                    ))}
                  </select>
                  {filterIteration.length > 0 && <p className="filter-count">{filterIteration.length} selected</p>}
                </div>

                <div> 
                  <label className="filter-label">State</label>
                    <select multiple className="filter-select" value={filterState} onChange={(e) => setFilterState([...e.target.selectedOptions].map(o => o.value))}>
                      {states.map(state => (
                        <option key={state} value={state}>{state}</option>
                      ))}
                    </select>
                  {filterState.length > 0 && <p className="filter-count">{filterState.length} selected</p>}
                </div>

                <div>
                  <label className="filter-label">Target Date (year)</label>
                    <select multiple className="filter-select" value={filterTargetDate} onChange={(e) => setFilterTargetDate([...e.target.selectedOptions].map(o => o.value))}>
                      {targetDates.map(year => (
                        <option key={year} value={year}>{year}</option>
                      ))}
                    </select>
                  {filterTargetDate.length > 0 && <p className="filter-count">{filterTargetDate.length} selected</p>}
                </div>
              </div>

              {loading ? <div>Loading...</div> : (
                <div className="table-wrapper">
                  <p style={{ padding: '15px', color: '#666', fontSize: '13px' }}>Showing {sortedFiltered.length} of {features.length}</p>
                  <table>
                    <thead>
                      <tr>
                          <th style={{ width: '30px' }}></th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('priority'); setSortOrder(sortColumn === 'priority' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            Priority {sortColumn === 'priority' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('title'); setSortOrder(sortColumn === 'title' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            Feature {sortColumn === 'title' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('areaPath'); setSortOrder(sortColumn === 'areaPath' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            Area Path {sortColumn === 'areaPath' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('iteration'); setSortOrder(sortColumn === 'iteration' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            Iteration {sortColumn === 'iteration' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('priority'); setSortOrder(sortColumn === 'priority' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            Priority {sortColumn === 'priority' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('targetDate'); setSortOrder(sortColumn === 'targetDate' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            Target Date {sortColumn === 'targetDate' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                          <th>Planned Month</th>
                          <th>BE</th>
                          <th>FE</th>
                          <th>QA</th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('state'); setSortOrder(sortColumn === 'state' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            State {sortColumn === 'state' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                          </th>
                        </tr>
                      </thead>
                    <tbody>
                     {sortedFiltered.map(f => (
                        <React.Fragment key={f.id}>
                              <tr>
                                <td className="expand-btn" onClick={() => setExpandedRows({...expandedRows, [f.id]: !expandedRows[f.id]})}>
                            {f.stories && f.stories.length > 0 ? (expandedRows[f.id] ? '▼' : '►') : ''}
                          </td>
                          <td><a href={adoLink(f.id)} target="_blank">{f.id}</a></td>
                          <td>{f.title.substring(0, 50)}</td>
                          <td style={{ fontSize: '11px' }}>{f.areaPath.split('\\\\').pop()}</td>
                          <td style={{ fontSize: '11px' }}>{f.iterationPath.split('\\\\').pop()}</td>
                          <td>{f.priority || '-'}</td>
                          <td style={{ fontSize: '11px' }}>{formatDate(f.targetDate)}</td>
                          <td>{f.plannedMonth || '-'}</td>
                          <td>{f.estimation.be || '-'}</td>
                          <td>{f.estimation.fe || '-'}</td>
                          <td>{f.estimation.qa || '-'}</td>
                          <td>{f.state}</td>
                        </tr>
                          {expandedRows[f.id] && f.stories && f.stories.length > 0 && (
                            <tr style={{ background: '#f9f9f9' }}>
                            <td colSpan="12" style={{ paddingLeft: '60px', paddingTop: '15px', paddingBottom: '15px' }}>
                              <div>
                              <strong style={{ marginBottom: '10px', display: 'block' }}>User Stories ({f.stories.length}):</strong>
                              {f.stories.map(story => (
                                <div key={story.id} style={{ padding: '8px', marginBottom: '8px', background: 'white', borderLeft: '3px solid #007bff', paddingLeft: '12px', borderRadius: '4px' }}>
                                  <strong>#{story.id}</strong> - {story.title} <br/>
                                  <span style={{ fontSize: '11px', color: '#666' }}>Points: {story.storyPoints} | State: {story.state}</span>
                              </div>
                              ))}
                            </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {currentPage === 'roadmap' && (
                <>
                <p style={{ color: '#666', fontSize: '13px', marginBottom: '20px' }}>Showing {sortedFiltered.length} Features in Roadmap (filtered)</p>
                  <div style={{ background: 'white', padding: '20px', borderRadius: '8px' }}>
                    <div style={{ fontSize: '13px' }}>
                      {sortedFiltered.slice(0, 15).map(f => (
                        <div key={f.id} style={{ padding: '15px', borderBottom: '1px solid #eee' }}>
                          <strong>#{f.id}</strong> - {f.title.substring(0, 60)}
                          <br/>
                          <span style={{ fontSize: '11px', color: '#666' }}>Target Date: {formatDate(f.targetDate)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
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
