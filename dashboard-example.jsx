import React, { useState, useEffect } from 'react';

/**
 * Dashboard que consume el API ADO Sync en vivo
 * 
 * Uso:
 * 1. Local: const API_URL = 'http://localhost:3000'
 * 2. Vercel: const API_URL = 'https://ado-feature-sync.vercel.app'
 */

const ADODashboard = () => {
  // Cambiar según dónde esté tu backend
  const API_URL = process.env.REACT_APP_ADO_API || 'http://localhost:3000';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Cargar datos del API
  const loadData = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/api/features`);
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Error loading features:', err);
    } finally {
      setLoading(false);
    }
  };

  // Cargar al montar y configurar refresh automático
  useEffect(() => {
    loadData();

    if (autoRefresh) {
      const interval = setInterval(loadData, 5 * 60 * 1000); // Cada 5 minutos
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  if (loading && !data) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>Cargando Features desde ADO...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '2rem', background: 'var(--bg-danger)', borderRadius: 'var(--radius)' }}>
        <p style={{ color: 'var(--text-danger)', margin: '0' }}>
          <strong>Error:</strong> {error}
        </p>
        <p style={{ color: 'var(--text-danger)', fontSize: '13px', margin: '8px 0 0' }}>
          Verifica que tu API esté corriendo en {API_URL}
        </p>
        <button
          onClick={loadData}
          style={{
            marginTop: '12px',
            padding: '8px 16px',
            background: 'var(--fill-accent)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            fontSize: '13px'
          }}
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (!data || !data.features) {
    return <div style={{ padding: '2rem' }}>Sin datos</div>;
  }

  const { features, summary, cached, cacheAge } = data;

  const riskColors = {
    'none': '#1baf7a',
    'no_estimate': '#fab219',
    'no_stories': '#ec835a',
    'underestimate': '#d95926',
    'overrun': '#d03b3b'
  };

  const riskLabels = {
    'none': '✓ OK',
    'no_estimate': '⚠ Sin estimación',
    'no_stories': '🔴 Sin historias',
    'underestimate': '📉 Subestimado',
    'overrun': '📈 Sobrepasado'
  };

  // Filtrar por riesgo
  const filteredFeatures = features.filter(f => {
    if (activeTab === 'overview') return true;
    if (activeTab === 'no_stories') return f.risk === 'no_stories';
    if (activeTab === 'underestimate') return f.risk === 'underestimate';
    if (activeTab === 'risks') return f.risk !== 'none';
    return true;
  });

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'var(--font-sans)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: '500', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
            ADO Feature Visibility Dashboard
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '0' }}>
            {cached ? `Datos en caché (${cacheAge}s atrás)` : 'Datos en vivo de Azure DevOps'}
            {' • '}{summary.total} Features
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh cada 5 min
          </label>
          <button
            onClick={loadData}
            disabled={loading}
            style={{
              padding: '6px 12px',
              background: 'var(--fill-accent)',
              color: 'white',
              border: 'none',
              borderRadius: 'var(--radius)',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              opacity: loading ? 0.6 : 1
            }}
          >
            {loading ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px', marginBottom: '2rem' }}>
        <div style={{ background: 'var(--surface-1)', padding: '1rem', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Total</p>
          <p style={{ fontSize: '24px', fontWeight: '500', color: 'var(--text-primary)', margin: '0' }}>{summary.total}</p>
        </div>
        <div style={{ background: 'var(--surface-1)', padding: '1rem', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Alineadas</p>
          <p style={{ fontSize: '24px', fontWeight: '500', color: '#1baf7a', margin: '0' }}>{summary.risks.none}</p>
        </div>
        <div style={{ background: 'var(--surface-1)', padding: '1rem', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Sin Historias</p>
          <p style={{ fontSize: '24px', fontWeight: '500', color: '#ec835a', margin: '0' }}>{summary.risks.no_stories}</p>
        </div>
        <div style={{ background: 'var(--surface-1)', padding: '1rem', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>En Riesgo</p>
          <p style={{ fontSize: '24px', fontWeight: '500', color: '#d03b3b', margin: '0' }}>
            {summary.risks.no_stories + summary.risks.underestimate + summary.risks.no_estimate}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--border)', marginBottom: '2rem', overflowX: 'auto' }}>
        {[
          { id: 'overview', label: 'Todas' },
          { id: 'no_stories', label: `Sin Historias (${summary.risks.no_stories})` },
          { id: 'underestimate', label: `Subestimadas (${summary.risks.underestimate})` },
          { id: 'risks', label: `En Riesgo` }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '12px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--fill-accent)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: activeTab === tab.id ? '500' : '400',
              whiteSpace: 'nowrap'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Features List */}
      <div style={{ display: 'grid', gap: '12px' }}>
        {filteredFeatures.slice(0, 50).map((feature) => {
          const gapPercent = feature.estimated > 0 ? Math.round(((feature.actual - feature.estimated) / feature.estimated) * 100) : 0;
          const borderColor = {
            'none': '#1baf7a',
            'no_estimate': '#fab219',
            'no_stories': '#ec835a',
            'underestimate': '#d95926',
            'overrun': '#d03b3b'
          }[feature.risk] || 'var(--border)';

          return (
            <div
              key={feature.id}
              style={{
                padding: '12px',
                background: 'var(--surface-1)',
                borderRadius: 'var(--radius)',
                border: `1px solid ${borderColor}`,
                display: 'grid',
                gap: '8px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text-primary)', margin: '0', wordBreak: 'break-word' }}>
                    {feature.title.substring(0, 60)}{feature.title.length > 60 ? '...' : ''}
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    ID: {feature.id} • {feature.state}
                  </p>
                </div>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '4px 8px',
                    background: borderColor,
                    color: 'white',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                    marginLeft: '8px',
                    fontWeight: '500'
                  }}
                >
                  {riskLabels[feature.risk]}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', fontSize: '12px' }}>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Estimado:</span>
                  <span style={{ fontWeight: '500', marginLeft: '4px', color: 'var(--text-primary)' }}>
                    {feature.estimated} SP
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Actual:</span>
                  <span style={{ fontWeight: '500', marginLeft: '4px', color: 'var(--text-primary)' }}>
                    {feature.actual} SP
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Historias:</span>
                  <span style={{ fontWeight: '500', marginLeft: '4px', color: 'var(--text-primary)' }}>
                    {feature.storiesCount}
                  </span>
                </div>
                {feature.estimated > 0 && (
                  <div style={{ color: gapPercent > 5 ? '#d03b3b' : gapPercent < -20 ? '#fab219' : '#1baf7a', fontWeight: '500' }}>
                    Δ {gapPercent > 0 ? '+' : ''}{gapPercent}%
                  </div>
                )}
              </div>

              {feature.targetDate && (
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0' }}>
                  Target: {feature.targetDate} {feature.plannedMonth && `| Release: ${feature.plannedMonth}`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {filteredFeatures.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          No hay features en esta categoría.
        </div>
      )}

      {filteredFeatures.length > 50 && (
        <p style={{ marginTop: '1.5rem', color: 'var(--text-secondary)', fontSize: '12px', textAlign: 'center' }}>
          Mostrando 50 de {filteredFeatures.length} features. Scroll para más.
        </p>
      )}
    </div>
  );
};

export default ADODashboard;
