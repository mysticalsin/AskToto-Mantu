import { createRoot } from 'react-dom/client'
import type { PermissionHelperApi } from '@shared/permission-helper'
import { PermissionHelperApp } from './PermissionHelper'
import './entry.css'

const api = (window as unknown as { metisHelper: PermissionHelperApi }).metisHelper
const host = document.getElementById('root')
if (host) createRoot(host).render(<PermissionHelperApp api={api} />)
