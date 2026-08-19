require('dotenv').config();
const express = require('express');
const axios = require('axios');

const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-app.html'));
});

app.get('/favicon.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.png'));
});

const { Redis } = require('@upstash/redis');

// Cliente Redis (lee automáticamente las env vars si se llaman KV_REST_API_URL / KV_REST_API_TOKEN)
const redis = Redis.fromEnv();
// Si tus variables tienen otro nombre, usa:
// const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

const OLD_FEATURES_CACHE_TTL_SECONDS = 12 * 60 * 60;
const RECENT_DAYS_THRESHOLD = 10;
const CACHE_KEY = 'oldFeaturesCache';

// ===== Cliente ADO reutilizable =====
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

// ===== Campos que se traen en el batch =====
// Los campos HTML se consultan solo para devolver una bandera boolean.
// Su contenido nunca se envía al navegador.
const FEATURE_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.AreaPath',
  'System.IterationPath',
  'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Scheduling.TargetDate',
  'Custom.PlannedMonth',
  'Custom.BEEstimate',
  'Custom.FEEstimates',
  'Custom.QASizing',
  'Custom.ReleaseFixVersion',
  'System.Tags',
  'System.AssignedTo',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'System.Description'
];

// ===== Evalúa si un campo simple o HTML tiene contenido visible =====
// No devuelve el texto; únicamente se usa para producir true / false.
function hasMeaningfulValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  const plainText = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim();

  return plainText.length > 0;
}

// ===== Mapeo de un work item crudo -> objeto de salida =====
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
    },
    requiredFields: {
      acceptanceCriteria: hasMeaningfulValue(
        i.fields['Microsoft.VSTS.Common.AcceptanceCriteria']
      ),
      businessImpact: false, // TODO: reemplazar cuando confirmemos el reference name real.
      parent: false, // TODO: se resolverá leyendo relaciones Hierarchy-Reverse del Feature.
      priority: Number(i.fields['Microsoft.VSTS.Common.Priority']) > 0,
      targetDate: hasMeaningfulValue(
        i.fields['Microsoft.VSTS.Scheduling.TargetDate']
      ),
      description: hasMeaningfulValue(i.fields['System.Description'])
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
  const range = { from: `@today - ${RECENT_DAYS_THRESHOLD}`, to: '@today + 1' };
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

    // 1. Leer el caché "antiguo" desde Redis (persiste entre cold starts e instancias)
    let oldFeaturesCache = await redis.get(CACHE_KEY); // devuelve null si no existe o ya expiró

    const cacheExpired = !oldFeaturesCache;

    if (cacheExpired || forceRefresh) {
      console.log(forceRefresh ? 'Refreshing cache by manual request...' : 'Cache expired, refreshing...');
      const oldResult = await fetchOldFeatures(c);
      oldFeaturesCache = {
        data: oldResult.features,
        rangeCounts: oldResult.rangeCounts,
        timestamp: now
      };
      // Guardamos en Redis con TTL nativo de 12h (en segundos)
      await redis.set(CACHE_KEY, oldFeaturesCache, { ex: OLD_FEATURES_CACHE_TTL_SECONDS });
    }

    // 2. La consulta "reciente" SIEMPRE es en vivo (nunca se cachea)
    const recentResult = await fetchRecentFeatures(c);

    // 3. Deduplicación: si un ID aparece en ambos lados, gana la versión reciente (fresca)
    const recentIds = new Set(recentResult.features.map(f => f.id));
    const cleanOldFeatures = oldFeaturesCache.data.filter(f => !recentIds.has(f.id));

    const allFeatures = [...recentResult.features, ...cleanOldFeatures];

    // 4. rangeCounts y warnings combinados
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

app.listen(process.env.PORT || 3000, () => console.log('ok'));
