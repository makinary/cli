# Makinari Installer (CLI)

Un instalador "One-Liner" para desplegar el ecosistema completo de **Makinari** en tu entorno local.

Este repositorio es el punto de entrada para desarrolladores. Automatiza la configuración de:

*   **Market Fit** (Frontend - Next.js)
*   **API** (Backend - Next.js API Routes)
*   **Workflows** (Motor de Procesos - Temporal + Node.js)
*   **Base de Datos Local** (Supabase + Docker) - *¡Opcional y Automático!*

El instalador resuelve automáticamente:
*   Instalación de dependencias (Docker, Supabase CLI, Node.js).
*   Inicio de servicios (Docker Desktop).
*   Clonado de repositorios.
*   Configuración de variables de entorno `.env` cruzadas (URLs de API, CORS, Puertos).
*   Inyección de credenciales de Supabase local en todos los servicios.

## 🚀 Instalación Rápida

1.  Clona este repositorio:
    ```bash
    git clone https://github.com/Uncodier/makinari-installer.git
    cd makinari-installer
    ```

2.  Ejecuta el asistente interactivo:
    ```bash
    ./install.sh
    ```

3.  Sigue las instrucciones en pantalla. El asistente te preguntará:
    *   Si quieres usar **Supabase Local** (recomendado para desarrollo) o conectar a una instancia en la nube.
    *   Qué puertos prefieres para cada servicio (o usar los predeterminados).
    *   Claves de API opcionales (OpenAI, Anthropic, Gemini).

## 📦 Estructura Resultante

Al finalizar, tendrás una estructura de carpetas como esta:

```
makinari-installer/
├── install.sh          # El script maestro
├── market-fit/         # Frontend
├── API/                # Backend
├── Workflows/          # Motor de procesos
└── makinari-db-scheme/ # Esquema de BD y Migraciones (solo si usas BD local)
```

## 🛠 Requisitos Previos

El instalador intentará instalar automáticamente lo que falte (en macOS), pero idealmente deberías tener:
*   Git
*   Node.js (v18+)
*   Docker Desktop (para BD local)

## 🏃‍♂️ Cómo Iniciar

Una vez completada la instalación, inicia cada servicio en una terminal separada:

1.  **Frontend:** `cd market-fit && npm run dev`
    *(Por defecto en http://localhost:3000)*

2.  **API:** `cd API && npm run dev`
    *(Por defecto en http://localhost:3001)*

3.  **Workflows:** `cd Workflows && npm run dev`
    *(Por defecto en http://localhost:3002)*

4.  **Base de Datos (si es local):**
    El instalador ya la habrá dejado corriendo. Puedes ver el dashboard en `http://localhost:54323`.
    Para detenerla: `cd makinari-db-scheme && supabase stop`
    Para iniciarla de nuevo: `cd makinari-db-scheme && supabase start`

## 🤝 Contribuir

Si necesitas mejorar el proceso de instalación o agregar nuevos servicios al ecosistema, edita `install.sh` y envía un Pull Request a este repositorio.