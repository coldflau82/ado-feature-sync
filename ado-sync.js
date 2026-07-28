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
        <div className="tabs" style={{ marginTop: '15px', display: 'flex', gap: '10px', borderBottom: '2px solid #eee', paddingBottom: '10px' }}>
          <button 
            style={{ padding: '8px 16px', background: currentPage === 'features' ? '#007bff' : 'white', color: currentPage === 'features' ? 'white' : 'black', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
            onClick={() => setCurrentPage('features')}
          >
            Feature List
          </button>
        </div>
      </div>

      {currentPage === 'features' && (
        <>
          <div className="filters">
            <button
              className={filterIteration === 'all' ? 'filter-btn active' : 'filter-btn'}
              onClick={() => setFilterIteration('all')}
            >
              Todas ({counts.all})
            </button>
            
            {iterations.map(iter => (
              <button
                key={iter}
                className={filterIteration === iter ? 'filter-btn active' : 'filter-btn'}
                onClick={() => setFilterIteration(iter)}
              >
                {getIterationName(iter)} ({counts[iter]})
              </button>
            ))}
          </div>

          {loading ? (
            <div>Cargando...</div>
          ) : (
            <div className="table-wrapper">
              <p style={{ padding: '15px', color: '#666', fontSize: '13px' }}>Mostrando {filtered.length} de {features.length}</p>
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Feature</th>
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
                      <td>
                        <a href={adoLink(f.id)} target="_blank" rel="noopener noreferrer">
                          {f.id}
                        </a>
                      </td>
                      <td>{f.title.substring(0, 50)}</td>
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
