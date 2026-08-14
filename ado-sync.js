require('dotenv').config();
const express = require('express');
const axios = require('axios');

// ===== CACHÉ PARA FEATURES "ANTIGUAS" (10-180 días) =====
let oldFeaturesCache = {
  data: null,
  rangeCounts: null,
  timestamp: 0
};
const OLD_FEATURES_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 horas en milisegundos
const RECENT_DAYS_THRESHOLD = 10; // Punto de corte entre "reciente" y "antiguo"

// ===== Cliente ADO reutilizable (antes lo creabas dentro del endpoint) =====
function getAdoClient() {
  return axios.create({
    baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
    headers: {
      Authorization: `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`,
      'Content-Type': 'application/json'
    }
  });
}


// ===== Filtro base de Area Path (idéntico al que ya tenías) =====
const BASE_FILTER = 'AND [System.State] <> "Removed" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")';

// ===== Campos que se traen en el batch (idénticos a los que ya tenías) =====
const FEATURE_FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Scheduling.TargetDate', 'Custom.PlannedMonth', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing', 'Custom.ReleaseFixVersion', 'System.Tags', 'System.AssignedTo'];

// ===== Mapeo de un work item crudo -> objeto de salida (idéntico a tu .map actual) =====
function mapFeature(i) {
  return {
    id: i.id,
    title: i.fields['System.Title'] || '',
    state: i.fields['System.State'] || '',
    areaPath: i.fields['System.AreaPath'] || '',
    iterationPath: i.fields['System.IterationPath'] || '',
    priority: i.fields['Microsoft.VSTS.Common.Priority'] || '',
    targetDate: i.fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
    plannedMonth: i.fields['Custom.PlannedMonth'] || '',
    releaseFixVersion: i.fields['Custom.ReleaseFixVersion'] || '',
    tags: i.fields['System.Tags'] || '',
    assignedTo: i.fields['System.AssignedTo']?.displayName || '',
    estimation: {
      be: i.fields['Custom.BEEstimate'] || '',
      fe: i.fields['Custom.FEEstimates'] || '',
      qa: i.fields['Custom.QASizing'] || ''
    }
  };
}

// ===== Trae IDs para un rango de fechas específico =====
async function fetchIdsForRange(c, range) {
  const r = await c.post('/wit/wiql?api-version=7.0', {
    query: `SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= ${range.from} AND [System.ChangedDate] < ${range.to} ${BASE_FILTER}`
  });
  return r.data.workItems.map(i => i.id);
}

// ===== Trae los campos completos en lotes de 200 (idéntico a tu lógica actual de batch) =====
async function fetchFeatureDetailsBatch(c, ids) {
  const batchSize = 200;
  let allFeatures = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = await c.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids.slice(i, i + batchSize),
      fields: FEATURE_FIELDS
    });
    allFeatures = [...allFeatures, ...batch.data.value];
  }
  return allFeatures;
}

// ===== Features editadas en los ÚLTIMOS 10 días (SIEMPRE en vivo) =====
async function fetchRecentFeatures(c) {
  const range = { from: `@today - ${RECENT_DAYS_THRESHOLD}`, to: '@today' };
  const rangeCounts = {};
  let ids = [];
  try {
    ids = await fetchIdsForRange(c, range);
    rangeCounts[`${range.from} to ${range.to}`] = ids.length;
  } catch (e) {
    rangeCounts[`${range.from} to ${range.to}`] = 'ERROR: ' + e.message;
  }
  const raw = ids.length ? await fetchFeatureDetailsBatch(c, ids) : [];
  return { features: raw.map(mapFeature), rangeCounts };
}

// ===== Features editadas entre 10 y 180 días (se cachea 12h en el servidor) =====
async function fetchOldFeatures(c) {
  const dateRanges = [
    { from: `@today - 20`, to: `@today - ${RECENT_DAYS_THRESHOLD}` },
    { from: '@today - 30', to: '@today - 20' },
    { from: '@today - 60', to: '@today - 30' },
    { from: '@today - 90', to: '@today - 60' },
    { from: '@today - 180', to: '@today - 90' }
  ];

  let allIds = [];
  const rangeCounts = {};

  for (const range of dateRanges) {
    try {
      const ids = await fetchIdsForRange(c, range);
      rangeCounts[`${range.from} to ${range.to}`] = ids.length;
      allIds = [...allIds, ...ids];
    } catch (e) {
      rangeCounts[`${range.from} to ${range.to}`] = 'ERROR: ' + e.message;
    }
  }

  const raw = allIds.length ? await fetchFeatureDetailsBatch(c, allIds) : [];
  return { features: raw.map(mapFeature), rangeCounts };
}

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: 1 }));

app.get('/api/feature-history/:id', async (req, res) => {
  try {
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const featureId = req.params.id;
    console.log('Fetching history for feature:', featureId);
    
    const revisionsResponse = await c.get(`/wit/workitems/${featureId}/revisions?api-version=7.0`);

    const stateChanges = [];
    let previousState = null;

    
    revisionsResponse.data.value.forEach(revision => {
      const currentState = revision.fields['System.State'];
  
      // Solo agregar si el estado cambió o es la primera revisión
      if (currentState && currentState !== previousState) {
        stateChanges.push({
          rev: revision.rev,
          state: currentState,
          changedDate: revision.fields['System.ChangedDate'],
          changedBy: revision.changedBy?.displayName || 'System'
        });
        previousState = currentState;
      }
    });

    res.json({
      id: featureId,
      stateChanges: stateChanges,
      totalRevisions: revisionsResponse.data.value.length
    });
  } catch (error) {
    console.error('Error fetching history:', error.message);
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

app.post('/api/features-history-batch', async (req, res) => {
  try {
    const ids = req.body.ids || [];
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const results = {};

    await Promise.all(ids.map(async (id) => {
      try {
        const revisionsResponse = await c.get(`/wit/workitems/${id}/revisions?api-version=7.0`);
        const stateChanges = [];
        let previousState = null;
        revisionsResponse.data.value.forEach(revision => {
          const currentState = revision.fields['System.State'];
          if (currentState && currentState !== previousState) {
            stateChanges.push({
              rev: revision.rev,
              state: currentState,
              changedDate: revision.fields['System.ChangedDate'],
              changedBy: revision.fields['System.ChangedBy']?.displayName || 'System'
            });
            previousState = currentState;
          }
        });
        results[id] = stateChanges;
      } catch (e) {
        results[id] = [];
      }
    }));

    res.json({ results: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/story-history/:id', async (req, res) => {
  try {
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const storyId = req.params.id;
    const revisionsResponse = await c.get(`/wit/workitems/${storyId}/revisions?api-version=7.0`);

    const stateChanges = [];
    let previousState = null;

    revisionsResponse.data.value.forEach(revision => {
      const currentState = revision.fields['System.State'];
      if (currentState && currentState !== previousState) {
        stateChanges.push({
          rev: revision.rev,
          state: currentState,
          changedDate: revision.fields['System.ChangedDate'],
          changedBy: revision.fields['System.ChangedBy']?.displayName || 'System'
        });
        previousState = currentState;
      }
    });

    // 👇 Tomamos el IterationPath de la última revisión (el estado actual)
    const revisions = revisionsResponse.data.value;
    const lastRevision = revisions[revisions.length - 1];
    const iterationPath = lastRevision?.fields['System.IterationPath'] || null;

    res.json({
      id: storyId,
      iterationPath: iterationPath,   // 👈 nuevo campo agregado
      stateChanges: stateChanges,
      totalRevisions: revisions.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stories-history-batch', async (req, res) => {
  try {
    const ids = req.body.ids || [];
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const results = {};

    await Promise.all(ids.map(async (id) => {
      try {
        const revisionsResponse = await c.get(`/wit/workitems/${id}/revisions?api-version=7.0`);
        const stateChanges = [];
        let previousState = null;
        revisionsResponse.data.value.forEach(revision => {
          const currentState = revision.fields['System.State'];
          if (currentState && currentState !== previousState) {
            stateChanges.push({
              rev: revision.rev,
              state: currentState,
              changedDate: revision.fields['System.ChangedDate'],
              changedBy: revision.fields['System.ChangedBy']?.displayName || 'System'
            });
            previousState = currentState;
          }
        });
        results[id] = stateChanges;
      } catch (e) {
        results[id] = [];
      }
    }));

    res.json({ results: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/feature-stories/:id', async (req, res) => {
  try {
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        Authorization: `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    const featureId = req.params.id;

    const query = `SELECT [System.Id] FROM workitems
      WHERE [System.TeamProject] = 'Commercial Engineering'
      AND ([System.WorkItemType] = 'User Story' OR [System.WorkItemType] = 'Bug')
      AND [System.Parent] = ${featureId}`;

    // WIQL no soporta System.Parent en WHERE, usamos WorkItemLinks
    const linksQuery = `SELECT [System.Id] FROM WorkItemLinks
      WHERE [Source].[System.Id] = ${featureId}
      AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
      MODE (Recursive)`;

    const linksResponse = await c.post('/wit/wiql?api-version=7.0', { query: linksQuery });
    const storyIds = linksResponse.data.workItemRelations
      .filter(r => r.target && r.target.id !== parseInt(featureId))
      .map(r => r.target.id);

    if (storyIds.length === 0) {
      return res.json({ stories: [] });
    }

    const batch = await c.post('/wit/workitemsbatch?api-version=7.0', {
      ids: storyIds,
      fields: ['System.Id', 'System.Title', 'Microsoft.VSTS.Scheduling.StoryPoints', 'System.State', 'System.WorkItemType', 'System.IterationPath',]
    });

    const stories = batch.data.value
      .filter(s => s.fields['System.WorkItemType'] === 'User Story' || s.fields['System.WorkItemType'] === 'Bug')
      .map(s => ({
        id: s.id,
        title: s.fields['System.Title'] || '',
        storyPoints: s.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0,
        state: s.fields['System.State'] || '',
        workItemType: s.fields['System.WorkItemType'] || '',
        iterationPath: s.fields['System.IterationPath'] || ''
      }));

    res.json({ stories: stories });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

app.get('/api/features', async (req, res) => {
  try {
    const c = getAdoClient();
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    // 1. Refrescar caché "antiguo" solo si expiró (12h) o si el usuario forzó refresh
    const cacheExpired = !oldFeaturesCache.data || (now - oldFeaturesCache.timestamp) > OLD_FEATURES_CACHE_TTL;

    if (cacheExpired || forceRefresh) {
      console.log(forceRefresh ? 'Refreshing cache by manual request...' : 'Cache expired, refreshing...');
      const oldResult = await fetchOldFeatures(c);
      oldFeaturesCache = {
        data: oldResult.features,
        rangeCounts: oldResult.rangeCounts,
        timestamp: now
      };
    }

    // 2. La consulta "reciente" SIEMPRE es en vivo (nunca se cachea)
    const recentResult = await fetchRecentFeatures(c);

    // 3. Deduplicación: si un ID aparece en ambos lados, gana la versión reciente (fresca)
    const recentIds = new Set(recentResult.features.map(f => f.id));
    const cleanOldFeatures = oldFeaturesCache.data.filter(f => !recentIds.has(f.id));
    oldFeaturesCache.data = cleanOldFeatures; // limpieza persistente en memoria

    const allFeatures = [...recentResult.features, ...cleanOldFeatures];

    // 4. rangeCounts y warnings combinados (igual que tu lógica original)
    const rangeCounts = { ...oldFeaturesCache.rangeCounts, ...recentResult.rangeCounts };
    const warnings = [];
    for (const [range, count] of Object.entries(rangeCounts)) {
      if (typeof count === 'number' && count >= 200) {
        warnings.push(`WARNING: Range "${range}" has ${count} items - DATA MAY BE MISSING`);
      }
    }

    res.json({
      rangeCounts,
      warnings,
      total: allFeatures.length,
      cacheInfo: {
        lastRefresh: new Date(oldFeaturesCache.timestamp).toISOString(),
        ageMinutes: Math.round((now - oldFeaturesCache.timestamp) / 60000)
      },
      features: allFeatures
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
    .tabs { margin-top: 12px; display: flex; gap: 10px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
    .tab-btn { padding: 8px 16px; background: white; color: black; border: none; cursor: pointer; border-radius: 4px; font-size: 13px; }
    .tab-btn.active { background: #007bff; color: white; }
    .warnings { background: #fff3cd; color: '#856404'; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffc107; }
    .filters { display: grid; gap: 15px; background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; overflow-x: auto; }
    .filter-div { }
    .filter-label { display: block; font-weight: bold; margin-bottom: 8px; font-size: 13px; }
    .filter-select { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
    .filter-count { font-size: 11px; color: #666; margin-top: 5px; }
    .clear-btn { width: 100%; padding: 10px 16px; background: #dc3545; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; font-size: 13px; margin-bottom: 12px; }
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

      const releaseDates = {
      'CE-2026-FEB': '2026-02-09',
      'CE-2026-FEB-SEMIMONTHLY': '2026-02-23',
      'CE-2026-MAR': '2026-03-09',
      'CE-2026-MAR-SEMIMONTHLY': '2026-03-23',
      'CE-2026-APR': '2026-04-12',
      'CE-2026-APR-SEMIMONTHLY': '2026-04-27',
      'CE-2026-MAY': '2026-05-11',
      'CE-2026-MAY-SEMIMONTHLY': '2026-05-25',
      'CE-2026-JUN': '2026-06-08',
      'CE-2026-JUN-SEMIMONTHLY': '2026-06-22',
      'CE-2026-JUL': '2026-07-13',
      'CE-2026-JUL-SEMIMONTHLY': '2026-07-27',
      'CE-2026-AUG': '2026-08-10',
      'CE-2026-AUG-SEMIMONTHLY': '2026-08-24',
      'CE-2026-SEP': '2026-09-14',
      'CE-2026-SEP-SEMIMONTHLY': '2026-09-28',
      'CE-2026-OCT': '2026-10-12',
      'CE-2026-OCT-SEMIMONTHLY': '2026-10-26',
      'CE-2026-NOV': '2026-11-09',
      'CE-2026-NOV-SEMIMONTHLY': '2026-11-23',
      'CE-2026-DEC': '2026-12-14'
    };
   
      const storyStateColors = {
      'New': '#94a3b8',
      'Business Refinement': '#facc15',
      'Technical Refinement': '#fb923c',
      'Ready for Development': '#f97316',
      'In Process': '#60a5fa',
      'QA Testing': '#38bdf8',
      'Business Sprint Testing': '#22d3ee',
      'Sprint Complete': '#2dd4bf',
      'User Acceptance Testing': '#34d399',
      'Approved for Release': '#4ade80',
      'Ready for Deployment': '#84cc16',
      'Closed': '#a78bfa'
    };

    function StoryRow({ storyId, title, storyPoints, state, iterationPath, formatDate, timelineStart, timelineEnd, adoLink, states, loading }) {
    
      const today = new Date();
      const timelineTotalDays = (timelineEnd - timelineStart) / (1000 * 60 * 60 * 24);
      const todayPercent = ((today - timelineStart) / (1000 * 60 * 60 * 24) / timelineTotalDays) * 100;
      const clampedTodayPercent = Math.max(0, Math.min(100, todayPercent));
    
      const segments = [];
      if (states.length > 0) {
        states.forEach((state, idx) => {
          const stateStart = new Date(state.changedDate);
          const stateEnd = idx === states.length - 1 ? today : new Date(states[idx + 1].changedDate);
    
          const daysFromStart = (stateStart - timelineStart) / (1000 * 60 * 60 * 24);
          const daysToEnd = (stateEnd - timelineStart) / (1000 * 60 * 60 * 24);
    
          const rawStartPercent = (daysFromStart / timelineTotalDays) * 100;
          const rawEndPercent = (daysToEnd / timelineTotalDays) * 100;
    
          if (rawStartPercent < 100 && rawEndPercent > 0) {
            const clampedStart = Math.max(0, rawStartPercent);
            const clampedEnd = Math.min(100, rawEndPercent);
            const widthPercent = Math.max(1, clampedEnd - clampedStart);
    
            segments.push({
              color: storyStateColors[state.state] || '#cccccc',
              state: state.state,
              startPercent: clampedStart,
              widthPercent: widthPercent
            });
          }
        });
      }
    
      // Sprint parsing (sin cambios)
      let sprintStart = null;
      let sprintEnd = null;
      const sprintMatch = iterationPath && iterationPath.match(/(\\d{4})_(S\\d+)_([A-Za-z]+)(\\d+)-([A-Za-z]+)(\\d+)/);
      let sprintLabel = '';
      if (sprintMatch) {
        const year = parseInt(sprintMatch[1]);
        sprintLabel = sprintMatch[2];
        const startMonth = sprintMatch[3];
        const startDay = parseInt(sprintMatch[4]);
        const endMonth = sprintMatch[5];
        const endDay = parseInt(sprintMatch[6]);
        const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        sprintStart = new Date(year, monthMap[startMonth], startDay);
        sprintEnd = new Date(year, monthMap[endMonth], endDay);
        if (monthMap[endMonth] < monthMap[startMonth]) {
          sprintEnd = new Date(year + 1, monthMap[endMonth], endDay);
        }
      }
    
      const getSprintPercent = (date) => {
        const days = (date - timelineStart) / (1000 * 60 * 60 * 24);
        return (days / timelineTotalDays) * 100;
      };

  
      return (
        <tr style={{ borderBottom: '1px solid #eee' }}>
          <td></td> {/* ← celda vacía para alinear con la columna del expand-btn de FeatureRow */}
          <td><a href={adoLink(storyId)} target="_blank">{storyId}</a></td>
          <td style={{ maxWidth: '300px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span title={title} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto', minWidth: '0' }}>{title}</span>
              <span style={{ color: '#999', flexShrink: 0, fontSize: '11px' }}>({storyPoints} pts)</span>
            </div>
          </td>
          <td style={{ padding: '8px' }}>  
            <div style={{ minHeight: '32px', background: '#f9f9f9', borderRadius: '4px', padding: '4px 10px', overflow: 'hidden', position: 'relative' }}>
    
              {/* Línea de "hoy" — MISMO estilo que FeatureRow */}
              {!loading && (
                <div style={{ position: 'absolute', top: '0', bottom: '0', left: clampedTodayPercent + '%', width: '1px', background: '#1e3a8a', opacity: 0.9, zIndex: 10 }} />
              )}
    
              {/* Badge de estado, anclado justo después de la línea de "hoy" */}
              {!loading && state && (
                <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: clampedTodayPercent + '%',
                    transform: 'translateY(-50%)',
                    zIndex: 15,
                    paddingLeft: '6px',
                    display: 'flex',
                    alignItems: 'center',
                    pointerEvents: 'none'
                  }}
                >
                  <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px', background: storyStateColors[state] || '#cccccc', color: 'white', whiteSpace: 'nowrap' }}>
                    {state}
                  </span>
                </div>
              )}
    
              {!loading && sprintStart && sprintEnd && (() => {
                const startPercent = getSprintPercent(sprintStart);
                const endPercent = getSprintPercent(sprintEnd);
              
                // Si el sprint está COMPLETAMENTE fuera del rango visible, no mostramos nada
                if (endPercent < 0 || startPercent > 100) return null;
              
                // Si hay overlap parcial, "clampeamos" para que se pinte en el borde visible
                const clampedStart = Math.max(0, startPercent);
                const clampedEnd = Math.min(100, endPercent);
                const midPercent = (clampedStart + clampedEnd) / 2;
              
                return (
                  <>
                    <div style={{ position: 'absolute', top: '0', bottom: '0', left: clampedStart + '%', width: '1px', borderLeft: '1px dashed #999', zIndex: 5 }} />
                    <div style={{ position: 'absolute', top: '0', bottom: '0', left: clampedEnd + '%', width: '1px', borderLeft: '1px dashed #999', zIndex: 5 }} />
                    <div style={{ position: 'absolute', top: '1px', left: midPercent + '%', transform: 'translateX(-50%)', fontSize: '9px', color: 'white', background: '#999', padding: '1px 4px', borderRadius: '2px', whiteSpace: 'nowrap', zIndex: 6 }}>
                      {sprintLabel}
                    </div>
                  </>
                );
              })()}
    
              {loading ? (
                <span style={{ fontSize: '11px', color: '#999' }}>Loading...</span>
              ) : segments.length === 0 ? (
                <span style={{ fontSize: '11px', color: '#999' }}>No data</span>
              ) : (
                <div style={{ width: '100%', position: 'relative', height: '20px' }}>
                  {segments.map((seg, idx) => (
                    <div
                      key={idx}
                      style={{
                        position: 'absolute',
                        left: seg.startPercent + '%',
                        width: seg.widthPercent + '%',
                        height: '20px',
                        background: seg.color,
                        borderRadius: '3px',
                        opacity: 0.85,
                        minWidth: '6px'
                      }}
                      title={seg.state}
                    />
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      );
    } 

 
    function FeatureRow({ featureId, title, targetDate, releaseFixVersion, formatDate, timelineStart, timelineEnd, adoLink, isExpanded, onToggleExpand, states, loading }) {
    
      const stateColors = {
        'New': '#94a3b8',
        'In Shaping': '#fbbf24',
        'In Planning': '#fb923c',
        'Planned': '#34d399',
        'In Process': '#60a5fa',
        'Closed': '#a78bfa'
      };
    
      const today = new Date();
      const timelineTotalDays = (timelineEnd - timelineStart) / (1000 * 60 * 60 * 24);
    
      const segments = [];
      if (states.length > 0) {
        states.forEach((state, idx) => {
          const stateStart = new Date(state.changedDate);
          const stateEnd = idx === states.length - 1 ? today : new Date(states[idx + 1].changedDate);
    
          const daysFromStart = (stateStart - timelineStart) / (1000 * 60 * 60 * 24);
          const daysToEnd = (stateEnd - timelineStart) / (1000 * 60 * 60 * 24);
    
          const rawStartPercent = (daysFromStart / timelineTotalDays) * 100;
          const rawEndPercent = (daysToEnd / timelineTotalDays) * 100;
    
          // Solo mostrar si está dentro del rango visible
          if (rawStartPercent < 100 && rawEndPercent > 0) {
            const clampedStart = Math.max(0, rawStartPercent);
            const clampedEnd = Math.min(100, rawEndPercent);
            const widthPercent = Math.max(1, clampedEnd - clampedStart);
    
            segments.push({
              color: stateColors[state.state] || '#cccccc',
              state: state.state,
              startPercent: clampedStart,
              widthPercent: widthPercent
            });
          }
        });
      }
    
      return (
        <tr style={{ borderBottom: '1px solid #eee' }}>
          <td className="expand-btn" onClick={onToggleExpand}>
            {isExpanded ? '▼' : '►'}
          </td>
          <td><a href={adoLink(featureId)} target="_blank">{featureId}</a></td>
          <td title={title} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }}>{title}</td>
          <td style={{ padding: '8px' }}>
            <div style={{ minHeight: '32px', background: '#f9f9f9', borderRadius: '4px', padding: '4px 10px', overflow: 'hidden', position: 'relative' }}>
    
              {/* Línea de "hoy" */}
              {!loading && (() => {
                const todayPercent = ((today - timelineStart) / (1000 * 60 * 60 * 24) / timelineTotalDays) * 100;
                if (todayPercent < 0 || todayPercent > 100) return null;
                return (
                  <div style={{ position: 'absolute', top: '0', bottom: '0', left: todayPercent + '%', width: '1px', background: '#1e3a8a', opacity: 0.9, zIndex: 10 }} />
                );
              })()}
    
              {/* Marcador de Target Date */}
              {!loading && targetDate && (() => {
                const target = new Date(targetDate);
                const targetPercent = ((target - timelineStart) / (1000 * 60 * 60 * 24) / timelineTotalDays) * 100;
                if (targetPercent < 0 || targetPercent > 100) return null;
                return (
                  <div
                    style={{ position: 'absolute', top: '-4px', left: targetPercent + '%', transform: 'translateX(-50%)', zIndex: 11, width: '0', height: '0', borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: '12px solid #f43f5e' }}
                    title={'Target: ' + formatDate(targetDate)}
                  />
                );
              })()}
    
              {/* Marcador de Release Fix Version (rombo) */}
              {!loading && releaseFixVersion && releaseDates[releaseFixVersion] && (() => {
                const releaseDate = new Date(releaseDates[releaseFixVersion]);
                const releasePercent = ((releaseDate - timelineStart) / (1000 * 60 * 60 * 24) / timelineTotalDays) * 100;
                if (releasePercent < 0 || releasePercent > 100) return null;
                return (
                  <div
                    style={{ position: 'absolute', top: '50%', left: releasePercent + '%', transform: 'translate(-50%, -50%) rotate(45deg)', zIndex: 12, width: '10px', height: '10px', background: '#1e3a8a' }}
                    title={releaseFixVersion + ': ' + formatDate(releaseDates[releaseFixVersion])}
                  />
                );
              })()}
    
              {loading ? (
                <span style={{ fontSize: '11px', color: '#999' }}>Loading...</span>
              ) : segments.length === 0 ? (
                <span style={{ fontSize: '11px', color: '#999' }}>No data</span>
              ) : (
                <div style={{ width: '100%', position: 'relative', height: '20px' }}>
                  {segments.map((seg, idx) => (
                    <div
                      key={idx}
                      style={{
                        position: 'absolute',
                        left: seg.startPercent + '%',
                        width: seg.widthPercent + '%',
                        height: '28px',
                        background: seg.color,
                        borderRadius: '3px',
                        opacity: 0.85,
                        minWidth: '6px'
                      }}
                      title={seg.state}
                    />
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      );
    }

    function Dashboard() {
      const [features, setFeatures] = useState([]);
      const [loading, setLoading] = useState(true);
      const [warnings, setWarnings] = useState([]);
      const [filterAreaPath, setFilterAreaPath] = useState([]);
      const [filterIteration, setFilterIteration] = useState([]);
      const [currentPage, setCurrentPage] = useState('roadmap');
      const [expandedRows, setExpandedRows] = useState({});
      const [searchTitle, setSearchTitle] = useState('');
      const [sortColumn, setSortColumn] = useState('id');
      const [sortOrder, setSortOrder] = useState('asc');
      const currentYear = String(new Date().getFullYear());
      const [filterState, setFilterState] = useState([]);
      const [filterTargetDate, setFilterTargetDate] = useState([currentYear]);
      const [filterReleaseVersion, setFilterReleaseVersion] = useState([]);
      const [roadmapPage, setRoadmapPage] = useState(1);
      const [timelineOffset, setTimelineOffset] = useState(-8);
      const [weekOffset, setWeekOffset] = useState(-8);
      const [expandedRoadmapFeatureId, setExpandedRoadmapFeatureId] = useState(null);
      const [historyCache, setHistoryCache] = useState({});
      const [loadingHistory, setLoadingHistory] = useState(false);
      const [storiesCache, setStoriesCache] = useState({});
      const [loadingStoriesIds, setLoadingStoriesIds] = useState({});
      const [storyHistoryCache, setStoryHistoryCache] = useState({});
      const [loadingStoryHistory, setLoadingStoryHistory] = useState(false);
      const [featuresPage, setFeaturesPage] = useState(1);
      const [filterAssignedTo, setFilterAssignedTo] = useState([]);
      const [saveAsDefault, setSaveAsDefault] = useState(false);
      const [filtersLoaded, setFiltersLoaded] = useState(false);
      const [legendExpanded, setLegendExpanded] = useState(false);

      useEffect(() => {
        setRoadmapPage(1);
        setFeaturesPage(1);
        setExpandedRoadmapFeatureId(null);
      }, [filterAreaPath, filterIteration, filterState, filterTargetDate, filterReleaseVersion, filterAssignedTo, searchTitle]);

      const [refreshing, setRefreshing] = useState(false);
      const [cacheInfo, setCacheInfo] = useState(null);
      
      async function loadFeatures(forceRefresh = false) {
        if (forceRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        try {
          const url = forceRefresh ? '/api/features?refresh=1' : '/api/features';
          const res = await fetch(url);
          const json = await res.json();
          setFeatures(json.features);
          setCacheInfo(json.cacheInfo);
          setWarnings(json.warnings || []);
        } catch (err) {
          console.error('Error loading features:', err);
        } finally {
          setLoading(false);
          setRefreshing(false);
        }
      }
      
      useEffect(() => {
        loadFeatures(false);
      }, []);

      useEffect(() => {
        setExpandedRoadmapFeatureId(null);
      }, [roadmapPage]);

      const areaPaths = [...new Set(features.map(f => f.areaPath).filter(a => a))].sort();
      const iterations = [...new Set(features.map(f => f.iterationPath).filter(a => a))].sort();
      const states = [...new Set(features.map(f => f.state).filter(a => a))].sort();
      const targetYears = [...new Set(features.map(f => f.targetDate ? new Date(f.targetDate).getFullYear() : null).filter(y => y))].sort((a, b) => b - a);
      const releaseVersions = [...new Set(features.map(f => f.releaseFixVersion).filter(v => v))].sort();
      const assignedTos = [...new Set(features.map(f => f.assignedTo).filter(a => a))].sort();

      const monthsByYear = {};
      features.forEach(f => {
        if (f.targetDate) {
          const d = new Date(f.targetDate);
          const y = d.getFullYear();
          const m = d.getMonth();
          if (!monthsByYear[y]) monthsByYear[y] = new Set();
          monthsByYear[y].add(m);
        }
      });

      const FILTER_STORAGE_KEY = 'featureTracker_defaultFilters';
      
        function saveDefaultFilters() {
          const filtersToSave = {
            filterAreaPath,
            filterIteration,
            filterState,
            filterTargetDate,
            filterReleaseVersion,
            filterAssignedTo
          };
          localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filtersToSave));
          alert('Default filter saved. It will load automatically next time you open this page.');
        }
        
        function clearDefaultFilters() {
          localStorage.removeItem(FILTER_STORAGE_KEY);
          alert('Default filter removed.');
        }

      useEffect(() => {
        const saved = localStorage.getItem(FILTER_STORAGE_KEY);
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            setFilterAreaPath(parsed.filterAreaPath || []);
            setFilterIteration(parsed.filterIteration || []);
            setFilterState(parsed.filterState || []);
            setFilterTargetDate(parsed.filterTargetDate || []);
            setFilterReleaseVersion(parsed.filterReleaseVersion || []);
            setFilterAssignedTo(parsed.filterAssignedTo || []);
            setSaveAsDefault(true);
          } catch (e) {
            console.error('Error loading saved filters:', e);
          }
        }
      }, []);
      
      useEffect(() => {
        if (!saveAsDefault) return;
        const filtersToSave = {
          filterAreaPath,
          filterIteration,
          filterState,
          filterTargetDate,
          filterReleaseVersion,
          filterAssignedTo
        };
        localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filtersToSave));
      }, [saveAsDefault, filterAreaPath, filterIteration, filterState, filterTargetDate, filterReleaseVersion, filterAssignedTo]);
      
      const filtered = features.filter(f => {
        const areaOk = filterAreaPath.length === 0 || filterAreaPath.includes(f.areaPath);
        const iterOk = filterIteration.length === 0 || filterIteration.includes(f.iterationPath);
        const stateOk = filterState.length === 0 || filterState.includes(f.state);
        const assignedOk = filterAssignedTo.length === 0 || filterAssignedTo.includes(f.assignedTo);
          let dateOk = filterTargetDate.length === 0;
          if (filterTargetDate.length > 0 && f.targetDate) {
            const d = new Date(f.targetDate);
            const yearMonthKey = d.getFullYear() + '-' + d.getMonth();
            const yearKey = String(d.getFullYear());
            dateOk = filterTargetDate.includes(yearMonthKey) || filterTargetDate.includes(yearKey);
          }        
          const searchOk = searchTitle === '' || f.title.toLowerCase().includes(searchTitle.toLowerCase()) || f.tags.toLowerCase().includes(searchTitle.toLowerCase());
          const releaseOk = filterReleaseVersion.length === 0 || filterReleaseVersion.includes(f.releaseFixVersion);
          return areaOk && iterOk && stateOk && dateOk && searchOk && releaseOk && assignedOk;
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
                const extractYearQuarter = (path) => {
                  const yearMatch = (path || '').match(/(\\d{4})/);
                  const quarterMatch = (path || '').match(/Q(\\d)/);
                  const year = yearMatch ? parseInt(yearMatch[1]) : 9999;
                  const quarter = quarterMatch ? parseInt(quarterMatch[1]) : 9;
                  return year * 10 + quarter;
                };
                valA = extractYearQuarter(a.iterationPath); 
                valB = extractYearQuarter(b.iterationPath); 
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

      const handleSaveAsDefaultChange = (e) => {
        const checked = e.target.checked;
        setSaveAsDefault(checked);
        if (!checked) {
          localStorage.removeItem(FILTER_STORAGE_KEY);
        }
      };

      const toggleFeatureExpand = (featureId) => {
        const isExpanding = !expandedRows[featureId];
        setExpandedRows({ ...expandedRows, [featureId]: isExpanding });
        if (isExpanding && !storiesCache[featureId]) {
          setLoadingStoriesIds(prev => ({ ...prev, [featureId]: true }));
          fetch('/api/feature-stories/' + featureId)
            .then(r => r.json())
            .then(d => {
              setStoriesCache(prev => ({ ...prev, [featureId]: d.stories || [] }));
              setLoadingStoriesIds(prev => ({ ...prev, [featureId]: false }));
            })
            .catch(() => {
              setStoriesCache(prev => ({ ...prev, [featureId]: [] }));
              setLoadingStoriesIds(prev => ({ ...prev, [featureId]: false }));
            });
        }
      };
      
      const toggleRoadmapFeature = (featureId) => {
        if (expandedRoadmapFeatureId === featureId) {
          setExpandedRoadmapFeatureId(null);
          return;
        }
        setExpandedRoadmapFeatureId(featureId);
        if (!storiesCache[featureId]) {
          setLoadingStoriesIds(prev => ({ ...prev, [featureId]: true }));
          fetch('/api/feature-stories/' + featureId)
            .then(r => r.json())
            .then(d => {
              setStoriesCache(prev => ({ ...prev, [featureId]: d.stories || [] }));
              setLoadingStoriesIds(prev => ({ ...prev, [featureId]: false }));
            })
            .catch(() => {
              setStoriesCache(prev => ({ ...prev, [featureId]: [] }));
              setLoadingStoriesIds(prev => ({ ...prev, [featureId]: false }));
            });
        }
      };
      
      const featuresItemsPerPage = 15;
      const featuresTotalPages = Math.ceil(sortedFiltered.length / featuresItemsPerPage);
      const featuresStartIdx = (featuresPage - 1) * featuresItemsPerPage;
      const featuresPageItems = sortedFiltered.slice(featuresStartIdx, featuresStartIdx + featuresItemsPerPage);

      
      const adoLink = (id) => \`https://dev.azure.com/tr-commercial-eng/Commercial%20Engineering/_workitems/edit/\${id}\`;

      const formatDate = (date) => {
        if (!date) return '-';
        return new Date(date).toLocaleDateString('es-CO');
      };
      
      const itemsPerPage = 15;
      const activeList = sortedFiltered; // Roadmap solo pagina Features, las historias nunca se paginan
      const totalPages = Math.ceil(activeList.length / itemsPerPage);
      const startIdx = (roadmapPage - 1) * itemsPerPage;
      const endIdx = startIdx + itemsPerPage;
      const pageItems = activeList.slice(startIdx, endIdx);
      const pageItemIds = pageItems.map(item => item.id).join(',');
      
      // Historias completas (sin paginar) del feature expandido en Roadmap
      const expandedRoadmapStories = expandedRoadmapFeatureId ? (storiesCache[expandedRoadmapFeatureId] || []) : [];
      const expandedStoryIds = expandedRoadmapStories.map(s => s.id).join(',');

      useEffect(() => {
        if (currentPage !== 'roadmap' || pageItems.length === 0) return;
        const ids = pageItems.map(item => item.id);
        setLoadingHistory(true);
        fetch('/api/features-history-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids })
        })
          .then(r => r.json())
          .then(d => {
            setHistoryCache(d.results || {});
            setLoadingHistory(false);
          })
          .catch(() => {
            setHistoryCache({});
            setLoadingHistory(false);
          });
      }, [pageItemIds, currentPage]);

      useEffect(() => {
        if (!expandedRoadmapFeatureId || expandedRoadmapStories.length === 0) {
          setStoryHistoryCache({});
          return;
        }
        const ids = expandedRoadmapStories.map(s => s.id);
        setLoadingStoryHistory(true);
        fetch('/api/stories-history-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids })
        })
          .then(r => r.json())
          .then(d => {
            setStoryHistoryCache(d.results || {});
            setLoadingStoryHistory(false);
          })
          .catch(() => {
            setStoryHistoryCache({});
            setLoadingStoryHistory(false);
          });
      }, [expandedRoadmapFeatureId, expandedStoryIds]);

        return (
          <div className="container">
           <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h1 style={{ margin: 0 }}>ADO Dashboard</h1>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button style={{ padding: '8px 16px', background: currentPage === 'features' ? '#007bff' : 'white', color: currentPage === 'features' ? 'white' : 'black', border: 'none', cursor: 'pointer', borderRadius: '4px', fontSize: '13px' }} onClick={() => setCurrentPage('features')}>Feature List</button>
              <button style={{ padding: '8px 16px', background: currentPage === 'roadmap' ? '#007bff' : 'white', color: currentPage === 'roadmap' ? 'white' : 'black', border: 'none', cursor: 'pointer', borderRadius: '4px', fontSize: '13px' }} onClick={() => setCurrentPage('roadmap')}>Roadmap</button>
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="warnings">
              <strong>⚠️ Data Warnings:</strong>
              {warnings.map((w, i) => <div key={i} style={{ fontSize: '13px', marginTop: '5px' }}>{w}</div>)}
            </div>
          )}

          <div style={{ background: 'white', padding: '15px', borderRadius: '8px', marginBottom: '12px', display: 'flex', gap: '20px', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flex: 1 }}>
              <div style={{ flex: '0 0 auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label style={{ fontWeight: 'bold', fontSize: '12px', whiteSpace: 'nowrap' }}>Search Feature Title</label>
                <input 
                  type="text" 
                  placeholder="Type feature title..." 
                  value={searchTitle}
                  onChange={(e) => setSearchTitle(e.target.value)}
                  style={{ width: '300px', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px' }}
                />
              </div>
          
            </div>
            <button style={{ padding: '8px 16px', background: '#537fbd', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', fontSize: '11px', whiteSpace: 'nowrap', flex: '0 0 auto' }} onClick={() => loadFeatures(true)} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh results'}
            </button>
            {cacheInfo && (
              <span style={{ fontSize: '11px', color: '#888', marginLeft: '8px' }}>
                Cache updated  {cacheInfo.ageMinutes} min ago
              </span>
            )}
            <button style={{ padding: '8px 16px', background: '#dc3545', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', fontSize: '12px', whiteSpace: 'nowrap', flex: '0 0 auto' }} onClick={() => { setFilterAreaPath([]); setFilterIteration([]); setFilterState([]); setFilterTargetDate([]); setFilterReleaseVersion([]); setFilterAssignedTo([]); }}>
              Clear filters
            </button>
          </div>

          <div className="filters-card" style={{ background: 'white', padding: '15px 20px 10px 20px', borderRadius: '8px', marginBottom: '12px' }}>

              <div style={{ display: 'grid', gridTemplateColumns: '0.7fr 1.7fr 0.8fr 0.5fr 0.8fr 0.6fr', gap: '15px', alignItems: 'start' }}>
                
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
                  <label className="filter-label">Assigned To</label>
                  <select multiple className="filter-select" value={filterAssignedTo} onChange={(e) => setFilterAssignedTo([...e.target.selectedOptions].map(o => o.value))}>
                    {assignedTos.map(person => (
                      <option key={person} value={person}>{person}</option>
                    ))}
                  </select>
                  {filterAssignedTo.length > 0 && <p className="filter-count">{filterAssignedTo.length} selected</p>}
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
                <label className="filter-label">Target Date (year/month)</label>
                  <select multiple className="filter-select" value={filterTargetDate} onChange={(e) => setFilterTargetDate([...e.target.selectedOptions].map(o => o.value))}>
                    {targetYears.map(year => (
                      <React.Fragment key={year}>
                        <option value={String(year)} style={{ fontWeight: 'bold' }}>{year}</option>
                        {[...(monthsByYear[year] || [])].sort((a, b) => a - b).map(month => (
                          <option key={year + '-' + month} value={year + '-' + month} style={{ paddingLeft: '15px' }}>
                            &nbsp;&nbsp;{new Date(2000, month, 1).toLocaleString('default', { month: 'long' })}
                          </option>
                        ))}
                      </React.Fragment>
                    ))}
                  </select>
                {filterTargetDate.length > 0 && <p className="filter-count">{filterTargetDate.length} selected</p>}
              </div>
              <div>
                <label className="filter-label">Release Fix Version</label>
                <select multiple className="filter-select" value={filterReleaseVersion} onChange={(e) => setFilterReleaseVersion([...e.target.selectedOptions].map(o => o.value))}>
                  {releaseVersions.map(rv => (
                    <option key={rv} value={rv}>{rv}</option>
                  ))}
                </select>
                {filterReleaseVersion.length > 0 && <p className="filter-count">{filterReleaseVersion.length} selected</p>}
              </div>
            </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '2px', marginTop: '4px', boxSizing: 'border-box' }}>
                <span style={{ color: '#666', fontSize: '10px', whiteSpace: 'nowrap' }}>
                  Showing {featuresPageItems.length} of {sortedFiltered.length} (Page {featuresPage} of {featuresTotalPages})
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap'  }}>
                  <input type="checkbox" checked={saveAsDefault} onChange={handleSaveAsDefaultChange} style={{ width: '12px', height: '12px', margin: 0 }} />
                  Save as default filter
                </label>
             </div>   
          </div>
              
          {currentPage === 'features' && (
            <>
              {loading ? <div>Loading...</div> : (
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                          <th style={{ width: '30px' }}></th>
                          <th style={{ cursor: 'pointer' }} onClick={() => { setSortColumn('id'); setSortOrder(sortColumn === 'id' && sortOrder === 'asc' ? 'desc' : 'asc'); }}>
                            ID {sortColumn === 'id' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
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
                     {featuresPageItems.map(f => (
                        <React.Fragment key={f.id}>
                        <tr>
                          <td className="expand-btn" onClick={() => toggleFeatureExpand(f.id)}>
                            {expandedRows[f.id] ? '▼' : '►'}
                          </td>
                          <td><a href={adoLink(f.id)} target="_blank">{f.id}</a></td>
                          <td title={f.title} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }}>{f.title}</td>
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
                        {expandedRows[f.id] && (() => {
                          if (loadingStoriesIds[f.id]) {
                            return (
                              <tr style={{ background: '#f9f9f9' }}>
                                <td colSpan="12" style={{ paddingLeft: '60px', paddingTop: '15px', paddingBottom: '15px' }}>
                                  Loading stories...
                                </td>
                              </tr>
                            );
                          }
                          const fStories = storiesCache[f.id] || [];
                          if (fStories.length === 0) {
                            return (
                              <tr style={{ background: '#f9f9f9' }}>
                                <td colSpan="12" style={{ paddingLeft: '60px', paddingTop: '15px', paddingBottom: '15px' }}>
                                  No stories found for this feature.
                                </td>
                              </tr>
                            );
                          }
                          return (
                            <tr style={{ background: '#f9f9f9' }}>
                            <td colSpan="12" style={{ paddingLeft: '60px', paddingTop: '15px', paddingBottom: '15px' }}>
                              <div>
                              <strong style={{ marginBottom: '10px', display: 'block' }}>User Stories ({fStories.length}):</strong>
                              {fStories.map(story => (
                                <div key={story.id} style={{ padding: '8px', marginBottom: '8px', background: 'white', borderLeft: '3px solid #007bff', paddingLeft: '12px', borderRadius: '4px' }}>
                                  <strong>#{story.id}</strong> - {story.title} <br/>
                                  <span style={{ fontSize: '11px', color: '#666' }}>Points: {story.storyPoints} | State: {story.state}</span>
                              </div>
                              ))}
                            </div>
                            </td>
                          </tr>
                          );
                        })()}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!loading && (
                <div style={{ background: 'white', padding: '20px', borderRadius: '8px', marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'center', alignItems: 'center' }}>
                  <button
                    style={{ padding: '8px 16px', background: featuresPage === 1 ? '#ccc' : '#007bff', color: 'white', border: 'none', cursor: featuresPage === 1 ? 'default' : 'pointer', borderRadius: '4px' }}
                    onClick={() => setFeaturesPage(featuresPage - 1)}
                    disabled={featuresPage === 1}
                  >
                    Previous
                  </button>
                  <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Page {featuresPage} of {featuresTotalPages}</span>
                  <button
                    style={{ padding: '8px 16px', background: featuresPage === featuresTotalPages ? '#ccc' : '#007bff', color: 'white', border: 'none', cursor: featuresPage === featuresTotalPages ? 'default' : 'pointer', borderRadius: '4px' }}
                    onClick={() => setFeaturesPage(featuresPage + 1)}
                    disabled={featuresPage === featuresTotalPages}
                  >
                    Next
                  </button>
                </div>
              )}
              </>
          )}
          
        {currentPage === 'roadmap' && (
            <>
                      
              {(() => {
            return (
              <>
                <div style={{ background: 'white', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
            
                  {/* Header clickeable: título + flecha */}
                  <div 
                    onClick={() => setLegendExpanded(!legendExpanded)}
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '15px', 
                      cursor: 'pointer',
                      userSelect: 'none'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Legend</span>
                      <span style={{ 
                        fontSize: '10px', 
                        transform: legendExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s'
                      }}>
                        ▼
                      </span>
                    </div>
                  
                    {/* Elementos siempre visibles */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                        <div style={{ width: '2px', height: '12px', background: '#333333', flexShrink: 0 }}></div>
                        <span style={{ fontSize: '10px' }}>Today</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                        <div style={{ width: '0', height: '0', borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '8px solid #f43f5e', flexShrink: 0 }}></div>
                        <span style={{ fontSize: '10px' }}>Target Date</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                        <div style={{ width: '8px', height: '8px', background: '#1e3a8a', transform: 'rotate(45deg)', flexShrink: 0 }}></div>
                        <span style={{ fontSize: '10px' }}>Release Fix Version</span>
                      </div>
                    </div>
                  </div>
            
                  {/* Contenido colapsable */}
                  {legendExpanded && (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'left', flexWrap: 'wrap', flexDirection: 'column', marginTop: '10px' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'left', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '11px', fontWeight: 'bold' }}>Feature States:</span>
                        {[
                          { label: 'New', color: '#94a3b8' },
                          { label: 'In Shaping', color: '#fbbf24' },
                          { label: 'In Planning', color: '#fb923c' },
                          { label: 'Planned', color: '#34d399' },
                          { label: 'In Process', color: '#60a5fa' },
                          { label: 'Closed', color: '#a78bfa' }
                        ].map((item, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <div style={{ width: '12px', height: '12px', background: item.color, borderRadius: '2px' }}></div>
                            <span style={{ fontSize: '10px' }}>{item.label}</span>
                          </div>
                        ))}
                      </div>
            
                      {/* Stories States Legend */}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', fontSize: '10px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 'bold' }}>Stories States:</span>
                        {Object.entries(storyStateColors).map(([state, color]) => (
                          <div key={state} style={{ display: 'flex', alignItems: 'left', gap: '4px' }}>
                            <div style={{ width: '12px', height: '12px', background: color, borderRadius: '2px' }}></div>
                            <span>{state}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
            
                </div>

                    {/* Timeline Headers */}
                    {expandedRoadmapFeatureId ? (() => {
                      const today = new Date();
                      const dayOfWeek = today.getDay();
                      const thisMonday = new Date(today);
                      thisMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                      
                      const weekLabels = [];
                      for (let i = 0; i < 12; i++) {
                        const weekStart = new Date(thisMonday);
                        weekStart.setDate(thisMonday.getDate() + (weekOffset + i) * 7);
                        weekLabels.push(weekStart.toLocaleString('default', { month: 'short', day: 'numeric' }));
                      }
                    
                      return (
                        <div style={{ display: 'flex', gap: '20px', padding: '12px', marginBottom: '10px', alignItems: 'center' }}>
                          <div style={{ flex: '0 0 300px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button 
                              style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontSize: '14px' }}
                              onClick={() => setWeekOffset(weekOffset - 1)}
                            >
                              ◄
                            </button>
                          </div>
                          <div style={{ flex: 1, background: '#e0e0e0', borderRadius: '4px', padding: '8px', display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '2px', fontSize: '9px', fontWeight: 'bold', textAlign: 'center' }}>
                            {weekLabels.map((w, i) => <div key={i}>{w}</div>)}
                          </div>
                          <button 
                            style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontSize: '14px' }}
                            onClick={() => setWeekOffset(weekOffset + 1)}
                          >
                            ►
                          </button>
                        </div>
                      );
                    })() : (() => {
                      const today = new Date();
                      const timelineStart = new Date(today.getFullYear(), today.getMonth() + timelineOffset, 1);
                      const monthLabels = [];
                      for (let i = 0; i < 12; i++) {
                        const m = new Date(timelineStart.getFullYear(), timelineStart.getMonth() + i, 1);
                        monthLabels.push(m.toLocaleString('default', { month: 'short', year: '2-digit' }));
                      }
                    
                      return (
                        <div style={{ display: 'flex', gap: '20px', padding: '12px', marginBottom: '10px', alignItems: 'center' }}>
                          <div style={{ flex: '0 0 300px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button 
                              style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontSize: '14px' }}
                              onClick={() => setTimelineOffset(timelineOffset - 1)}
                            >
                              ◄
                            </button>
                          </div>
                          <div style={{ flex: 1, background: '#e0e0e0', borderRadius: '4px', padding: '8px', display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '2px', fontSize: '10px', fontWeight: 'bold', textAlign: 'center' }}>
                            {monthLabels.map((m, i) => <div key={i}>{m}</div>)}
                          </div>
                          <button 
                            style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '4px', fontSize: '14px' }}
                            onClick={() => setTimelineOffset(timelineOffset + 1)}
                          >
                            ►
                          </button>
                        </div>
                      );
                    })()}

                    <div className="table-wrapper" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                      <table>
                        <thead>
                          <tr>
                            <th style={{ width: '30px' }}></th>
                            <th style={{ width: '80px' }}>ID</th>
                            <th style={{ width: '300px' }}>Feature</th>
                            <th>Timeline</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const today = new Date();
                          
                            // Rango en MESES — para features colapsadas (vista general)
                            const monthTimelineStart = new Date(today.getFullYear(), today.getMonth() + timelineOffset, 1);
                            const monthTimelineEnd = new Date(today.getFullYear(), today.getMonth() + timelineOffset + 12, 0);
                          
                            // Rango en SEMANAS — para la feature expandida y sus stories
                            const dayOfWeek = today.getDay();
                            const thisMonday = new Date(today);
                            thisMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                            const weekTimelineStart = new Date(thisMonday);
                            weekTimelineStart.setDate(thisMonday.getDate() + weekOffset * 7);
                            const weekTimelineEnd = new Date(weekTimelineStart);
                            weekTimelineEnd.setDate(weekTimelineStart.getDate() + 12 * 7);
                          
                            return pageItems.map(f => {
                              const isExpanded = expandedRoadmapFeatureId === f.id;
                              // La feature expandida usa escala de semanas; el resto, escala de meses
                              const featureTimelineStart = isExpanded ? weekTimelineStart : monthTimelineStart;
                              const featureTimelineEnd = isExpanded ? weekTimelineEnd : monthTimelineEnd;
                          
                              return (
                                <React.Fragment key={f.id}>
                                  <FeatureRow 
                                    featureId={f.id} 
                                    title={f.title} 
                                    targetDate={f.targetDate} 
                                    releaseFixVersion={f.releaseFixVersion} 
                                    formatDate={formatDate} 
                                    timelineStart={featureTimelineStart}
                                    timelineEnd={featureTimelineEnd}
                                    adoLink={adoLink} 
                                    isExpanded={isExpanded}
                                    onToggleExpand={() => toggleRoadmapFeature(f.id)}
                                    states={historyCache[f.id] || []} 
                                    loading={loadingHistory} 
                                  />
                                  {isExpanded && (
                                    loadingStoriesIds[f.id] ? (
                                      <tr>
                                        <td colSpan="4" style={{ padding: '20px', textAlign: 'center' }}>Loading stories...</td>
                                      </tr>
                                    ) : (
                                      (storiesCache[f.id] || []).map(s => (
                                        <StoryRow 
                                          key={s.id} 
                                          storyId={s.id} 
                                          title={s.title} 
                                          storyPoints={s.storyPoints} 
                                          state={s.state} 
                                          iterationPath={s.iterationPath} 
                                          formatDate={formatDate} 
                                          timelineStart={weekTimelineStart}
                                          timelineEnd={weekTimelineEnd}
                                          adoLink={adoLink} 
                                          states={storyHistoryCache[s.id] || []} 
                                          loading={loadingStoryHistory} 
                                        />
                                      ))
                                    )
                                  )}
                                </React.Fragment>
                              );
                            });
                          })()}
                        </tbody>
                      </table>
                    </div>
                
                   {!loading && (
                <div style={{ background: 'white', padding: '20px', borderRadius: '8px', marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'center', alignItems: 'center' }}>
                  <button 
                      style={{ padding: '8px 16px', background: roadmapPage === 1 ? '#ccc' : '#007bff', color: 'white', border: 'none', cursor: roadmapPage === 1 ? 'default' : 'pointer', borderRadius: '4px' }}
                      onClick={() => setRoadmapPage(roadmapPage - 1)}
                      disabled={roadmapPage === 1}
                    >
                      Previous
                    </button>
                    <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Page {roadmapPage} of {totalPages}</span>
                    <button 
                      style={{ padding: '8px 16px', background: roadmapPage === totalPages ? '#ccc' : '#007bff', color: 'white', border: 'none', cursor: roadmapPage === totalPages ? 'default' : 'pointer', borderRadius: '4px' }}
                      onClick={() => setRoadmapPage(roadmapPage + 1)}
                      disabled={roadmapPage === totalPages}
                    >
                      Next
                    </button>
                  </div>
                )}
                </>
              );
            })()}
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
