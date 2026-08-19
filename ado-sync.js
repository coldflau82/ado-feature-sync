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
  'System.Description',
  'Custom.PI_CustomerBenefit',
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

// ===== Determina si el Feature tiene un Parent jerárquico =====
// Solo devuelve true / false. No expone información del elemento padre.
function hasParentRelation(workItem) {
  return Array.isArray(workItem.relations) &&
    workItem.relations.some(
      relation => relation.rel === 'System.LinkTypes.Hierarchy-Reverse'
    );
}

const UNKNOWN = 'unknown';

// ===== Evalúa si un campo simple o HTML tiene contenido visible =====
// Devuelve true / false. No devuelve ni expone el contenido.
function hasMeaningfulValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  // Para campos HTML como Description y Acceptance Criteria,
  // evita considerar "<p></p>" o "&nbsp;" como contenido válido.
  if (typeof value === 'string') {
    const plainText = value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .trim();

    return plainText.length > 0;
  }

  // Valores como 0 o false siguen siendo valores existentes.
  return true;
}

// ===== Determina si el Feature tiene un Parent jerárquico =====
function hasParentRelation(workItem) {
  return Array.isArray(workItem.relations) &&
    workItem.relations.some(
      relation => relation.rel === 'System.LinkTypes.Hierarchy-Reverse'
    );
}

// ===== Resultado de validación para campos obtenidos desde ADO =====
// Si ADO no devolvió el work item o falló la consulta de campos,
// no se debe decir que el dato está ausente: es "unknown".
function fieldCheck(sourceStatus, value) {
  if (sourceStatus === UNKNOWN) {
    return UNKNOWN;
  }

  return hasMeaningfulValue(value);
}

// ===== Validación específica para Priority =====
// Priority debe existir y ser un número mayor a cero.
function priorityCheck(sourceStatus, value) {
  if (sourceStatus === UNKNOWN) {
    return UNKNOWN;
  }

  return Number(value) > 0;
}

// ===== Mapeo de un work item crudo -> objeto de salida =====
function mapFeature(i) {
  const fields = i.fields || {};

  // Compatibilidad: si un objeto no tiene _healthSource,
  // asumimos que sus datos llegaron correctamente.
  const fieldsSource = i._healthSource?.fields || 'ok';
  const relationsSource = i._healthSource?.relations || 'ok';

  const requiredFields = {
    acceptanceCriteria: fieldCheck(
      fieldsSource,
      fields['Microsoft.VSTS.Common.AcceptanceCriteria']
    ),

    businessImpact: fieldCheck(
      fieldsSource,
      fields['Custom.PI_CustomerBenefit']
    ),

    parent:
      relationsSource === UNKNOWN
        ? UNKNOWN
        : hasParentRelation(i),

    priority: priorityCheck(
      fieldsSource,
      fields['Microsoft.VSTS.Common.Priority']
    ),

    targetDate: fieldCheck(
      fieldsSource,
      fields['Microsoft.VSTS.Scheduling.TargetDate']
    ),

    description: fieldCheck(
      fieldsSource,
      fields['System.Description']
    )
  };

  const missingChecks = Object.entries(requiredFields)
    .filter(([, value]) => value === false)
    .map(([name]) => name);

  const unknownChecks = Object.entries(requiredFields)
    .filter(([, value]) => value === UNKNOWN)
    .map(([name]) => name);

  // Política de salud:
  // - Incomplete: se confirmó que al menos un requisito falta.
  // - Unknown: no falta nada confirmado, pero ADO no permitió validar algo.
  // - Healthy: todos los criterios fueron comprobados y cumplen.
  const health =
    missingChecks.length > 0
      ? 'Incomplete'
      : unknownChecks.length > 0
        ? 'Unknown'
        : 'Healthy';

  return {
    // ===== Datos existentes para el dashboard: se conservan =====
    id: i.id,
    title: fields['System.Title'] || '',
    state: fields['System.State'] || '',
    areaPath: fields['System.AreaPath'] || '',
    iterationPath: fields['System.IterationPath'] || '',
    priority: fields['Microsoft.VSTS.Common.Priority'] || '',
    targetDate: fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
    plannedMonth: fields['Custom.PlannedMonth'] || '',
    releaseFixVersion: fields['Custom.ReleaseFixVersion'] || '',
    tags: fields['System.Tags'] || '',
    assignedTo: fields['System.AssignedTo']?.displayName || '',

    estimation: {
      be: fields['Custom.BEEstimate'] || '',
      fe: fields['Custom.FEEstimates'] || '',
      qa: fields['Custom.QASizing'] || ''
    },

    // ===== Indicador de salud =====
    requiredFields,
    health,
    missingChecks,
    unknownChecks,

    // Útil para diagnóstico técnico; no contiene datos sensibles.
    dataSources: {
      fields: fieldsSource,
      relations: relationsSource
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

// ===== Trae campos y relaciones de Features en lotes de 200 =====
// Cada verificación conserva la diferencia entre:
// - dato consultado correctamente ("ok")
// - dato que no se pudo obtener ("unknown")
async function fetchFeatureDetailsBatch(c, ids) {
  const batchSize = 200;
  let allFeatures = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const currentIds = ids.slice(i, i + batchSize);

    const [fieldsResult, relationsResult] = await Promise.allSettled([
      c.post('/wit/workitemsbatch?api-version=7.0', {
        ids: currentIds,
        fields: FEATURE_FIELDS,
        errorPolicy: 'Omit'
      }),

      c.post('/wit/workitemsbatch?api-version=7.0', {
        ids: currentIds,
        $expand: 'Relations',
        errorPolicy: 'Omit'
      })
    ]);

    // Si falla la consulta de campos, se registra el problema,
    // pero no se marca el contenido como "faltante": será "unknown".
    if (fieldsResult.status === 'rejected') {
      const error = fieldsResult.reason;

      console.error('ERROR fetching Feature fields batch from ADO', {
        batchStart: i,
        batchSize: currentIds.length,
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        message: error.message
      });
    }

    // Si falla la consulta de relaciones, Parent será "unknown",
    // no false.
    if (relationsResult.status === 'rejected') {
      const error = relationsResult.reason;

      console.error('ERROR fetching Feature relations batch from ADO', {
        batchStart: i,
        batchSize: currentIds.length,
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        message: error.message
      });
    }

    const fieldsResponse =
      fieldsResult.status === 'fulfilled'
        ? fieldsResult.value.data.value || []
        : [];

    const relationsResponse =
      relationsResult.status === 'fulfilled'
        ? relationsResult.value.data.value || []
        : [];

    // Permite distinguir entre:
    // - Feature recibida sin relaciones: no tiene Parent => false.
    // - Feature no recibida en la consulta de relaciones: unknown.
    const fieldsById = new Map(
      fieldsResponse.map(workItem => [workItem.id, workItem])
    );

    const relationsById = new Map(
      relationsResponse.map(workItem => [workItem.id, workItem])
    );

    // Conservamos todos los IDs solicitados, incluso si ADO omitió alguno.
    const mergedFeatures = currentIds.map(id => {
      const fieldsWorkItem = fieldsById.get(id);
      const relationsWorkItem = relationsById.get(id);

      return {
        id,

        // Si no se pudieron obtener los campos, se deja vacío.
        // mapFeature usará _healthSource para devolver "unknown".
        fields: fieldsWorkItem?.fields || {},

        // Una lista vacía solo significa "sin Parent" cuando la consulta
        // de relaciones sí devolvió este work item.
        relations: relationsWorkItem?.relations || [],

        _healthSource: {
          fields:
            fieldsResult.status === 'fulfilled' && fieldsWorkItem
              ? 'ok'
              : 'unknown',

          relations:
            relationsResult.status === 'fulfilled' && relationsWorkItem
              ? 'ok'
              : 'unknown'
        }
      };
    });

    allFeatures = [...allFeatures, ...mergedFeatures];
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
    console.error('ERROR /api/features', {
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      message: error.message
    });

    res.status(500).json({
      error: 'Unable to fetch Features from ADO.'
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
