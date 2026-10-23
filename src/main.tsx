import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyBrandTheme, applyPublicBrand } from '../config/branding'
import { platform } from './services/platformFacade'

applyBrandTheme()
async function start() {
  const tenantRoute=/^\/t\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/|$)/.test(window.location.pathname)
  if (tenantRoute) {
    try {
      const config = await platform.brand.publicConfig()
      applyPublicBrand(config, true)
    } catch { /* O app continua com a identidade padrão se a configuração pública estiver indisponível. */ }
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
}
void start()
