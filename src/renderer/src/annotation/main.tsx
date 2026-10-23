import { createRoot } from 'react-dom/client'
import type { MarkView } from '@shared/screen-marks'
import { AnnotationLayer } from './AnnotationLayer'
import './entry.css'

const api = (window as unknown as { metisAnnotation?: { onMarks(l: (m: MarkView[]) => void): () => void } }).metisAnnotation
const host = document.getElementById('root')
if (host && api) createRoot(host).render(<AnnotationLayer subscribe={api.onMarks} />)
