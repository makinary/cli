# Makinari Installer (CLI)

Un instalador "One-Liner" para desplegar el ecosistema completo de **Makinari** en tu entorno local.

Este repositorio es el punto de entrada para desarrolladores. Automatiza la configuración de:

*   **Market Fit** (Frontend - Next.js)
*   **API** (Backend - Next.js API Routes)
*   **Workflows** (Motor de Procesos - Temporal + Node.js)
*   Conexiones cruzadas (CORS, URLs de API, Puertos)
*   Generación de archivos `.env` interactiva.

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

3.  Sigue las instrucciones en pantalla para configurar puertos y claves (Supabase, OpenAI, etc.).

## 📦 Estructura Resultante

Al finalizar, tendrás una estructura de carpetas como esta:

```
makinari-installer/
├── install.sh      # El script de instalación (este repo)
├── market-fit/     # Repositorio Frontend clonado
├── API/            # Repositorio API clonado
└── Workflows/      # Repositorio Workflows clonado
```

## 🛠 Comandos Útiles

Una vez instalado todo, puedes iniciar los servicios individualmente entrando en cada carpeta:

*   **Frontend:** `cd market-fit && npm run dev`
*   **API:** `cd API && npm run dev`
*   **Workflows:** `cd Workflows && npm run dev`

## 🤝 Contribuir

Si necesitas mejorar el proceso de instalación o agregar nuevos servicios al ecosistema, edita `install.sh` y envía un Pull Request a este repositorio.
