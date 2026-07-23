# ADO Feature Visibility Backend

Backend robusto que sincroniza Features y User Stories desde Azure DevOps en tiempo real.

---

## Requisitos previos

### 1. Obtener tu Personal Access Token (PAT) de Azure DevOps

1. Ve a **dev.azure.com** → tu organización
2. Haz click en **User settings** (ícono de persona arriba a la derecha)
3. Selecciona **Personal access tokens**
4. Click en **+ New Token**
5. Completa:
   - **Name**: `ado-feature-sync`
   - **Scopes**: Selecciona **Work Items (Read)**
   - **Expiration**: 1 año
6. Click **Create**
7. **COPIA el token** (aparece una sola vez)
8. **Guárdalo seguro** — no lo compartas públicamente

### 2. Datos que necesitarás

- **Organización**: El nombre de tu organización en Azure DevOps (la URL es `dev.azure.com/[ESTO]`)
- **Proyecto**: El nombre de tu proyecto
- **PAT**: El token que acabas de crear

---

## Opción B1: Deploy Local (Tu máquina)

Ideal para **probar primero** o si prefieres hosting interno.

### Instalación

```bash
# 1. Clone o descarga los archivos (ado-sync.js, package.json, .env.example)
# 2. Crea un archivo .env en la misma carpeta
cp .env.example .env

# 3. Abre .env y llena tus datos:
# ADO_ORG=tu-organizacion
# ADO_PROJECT=tu-proyecto
# ADO_PAT=tu-pat-aqui
# PORT=3000

# 4. Instala dependencias
npm install

# 5. Inicia el servidor
npm start
```

### Verificar que funciona

```bash
# En otra terminal o en tu navegador:
curl http://localhost:3000/api/health

# Debería devolver:
# {"status":"ok","timestamp":"2024-01-15T10:30:00Z"}
```

### Acceder al API

- **Todas las Features**: http://localhost:3000/api/features
- **Feature específica**: http://localhost:3000/api/features/768249
- **Health check**: http://localhost:3000/api/health

---

## Opción B2: Deploy Cloud (Vercel) — SIN MANTENIMIENTO

Ideal para **usar en todo el equipo** sin pensar en mantenimiento.

### Paso 1: Preparar en GitHub

1. Ve a **github.com** → crea un nuevo repo: `ado-feature-sync`
2. En tu máquina local:
   ```bash
   git clone https://github.com/tu-usuario/ado-feature-sync.git
   cd ado-feature-sync
   ```

3. Copia estos 3 archivos al repo:
   - `ado-sync.js`
   - `package.json`
   - `.env.example`

4. Crea un archivo `vercel.json`:
   ```json
   {
     "version": 2,
     "builds": [
       { "src": "ado-sync.js", "use": "@vercel/node" }
     ],
     "routes": [
       { "src": "/(.*)", "dest": "ado-sync.js" }
     ],
     "env": {
       "ADO_ORG": "@ado_org",
       "ADO_PROJECT": "@ado_project",
       "ADO_PAT": "@ado_pat"
     }
   }
   ```

5. Git push:
   ```bash
   git add .
   git commit -m "Initial commit: ADO Feature Sync backend"
   git push origin main
   ```

### Paso 2: Deploy en Vercel

1. Ve a **vercel.com** → Sign up/Log in
2. Click **Add New** → **Project**
3. Selecciona tu repo `ado-feature-sync`
4. Click **Import**
5. En **Environment Variables**, añade:
   - `ADO_ORG`: tu organización
   - `ADO_PROJECT`: tu proyecto
   - `ADO_PAT`: tu token (¡Vercel encripta esto!)
6. Click **Deploy**

**¡Listo!** Tu API está live en:
```
https://ado-feature-sync.vercel.app/api/features
```

### Actualizar el código

Cada vez que hagas `git push`, Vercel redeploys automáticamente. Cero mantenimiento.

---

## Consumir el API desde tu Dashboard

El API devuelve JSON como este:

```json
{
  "features": [
    {
      "id": "768249",
      "title": "Save Quote MVP",
      "state": "In Planning",
      "estimated": 74,
      "actual": 0,
      "delta": -74,
      "storiesCount": 0,
      "risk": "no_stories",
      "targetDate": "2025-04-29",
      "plannedMonth": ""
    }
  ],
  "summary": {
    "total": 253,
    "risks": {
      "none": 119,
      "no_estimate": 15,
      "no_stories": 71,
      "underestimate": 42,
      "overrun": 6
    }
  },
  "cached": false,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Fetch en JavaScript (tu dashboard):

```javascript
async function loadFeatures() {
  const response = await fetch('http://localhost:3000/api/features');
  // O en Vercel:
  // const response = await fetch('https://ado-feature-sync.vercel.app/api/features');
  
  const data = await response.json();
  console.log('Features:', data.features);
  console.log('Summary:', data.summary);
}

loadFeatures();
```

---

## Troubleshooting

### Error: "ECONNREFUSED" (no puede conectar a ADO)
- Verifica que ADO_PAT esté correcto
- Verifica que ADO_ORG y ADO_PROJECT sean exactos
- Comprueba la autenticación en dev.azure.com manualmente

### Error: "401 Unauthorized"
- El PAT expiró → genera uno nuevo
- El PAT no tiene permisos → verifica que está configurado con "Work Items (Read)"

### Error: "Cannot find module 'express'"
- Ejecutaste `npm install`? Intenta de nuevo:
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```

### Vercel devuelve "502 Bad Gateway"
- Abre **vercel.com** → tu proyecto → **Deployments**
- Haz click en el último deployment → **Logs**
- Busca el error real en los logs

---

## Seguridad

- **Nunca** commits el `.env` con el PAT real
- Usa `.env.local` para desarrollo local (gitignore)
- En Vercel, los secrets se encriptan y están seguros
- Si el PAT se expone, genera uno nuevo inmediatamente

---

## Próximo paso

Una vez que el API esté corriendo (local o cloud), conecta tu dashboard:

```javascript
// En tu React dashboard:
const [features, setFeatures] = useState([]);

useEffect(() => {
  fetch('/api/features') // O la URL de Vercel
    .then(r => r.json())
    .then(data => setFeatures(data.features))
    .catch(err => console.error('Error:', err));
}, []);
```

---

## Soporte

¿Preguntas?
1. Verifica que el PAT esté correcto en `.env`
2. Prueba `/api/health` para confirmar que el servidor está corriendo
3. Checa los logs: `npm start` mostrará errores en tiempo real
