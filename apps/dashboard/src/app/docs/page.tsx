'use client'

import { useEffect, useRef } from 'react'
import Script from 'next/script'

declare global {
  interface Window {
    SwaggerUIBundle: (config: Record<string, unknown>) => void
    SwaggerUIStandalonePreset: unknown
  }
}

// CSS for Swagger UI theming - uses .dark class selector
const swaggerStyles = `
  .swagger-ui .topbar { display: none !important; }
  .swagger-ui { font-family: system-ui, sans-serif; }

  /* ===== LIGHT MODE (default) ===== */
  .swagger-ui .info .title { color: #09090b !important; }
  .swagger-ui .info .description, .swagger-ui .info .description p { color: #71717a !important; }
  .swagger-ui .info a { color: #8b5cf6 !important; }
  .swagger-ui .info .base-url { color: #71717a !important; }

  .swagger-ui .wrapper { background: transparent !important; }
  .swagger-ui .information-container { background: transparent !important; }

  .swagger-ui .scheme-container {
    background: #ffffff !important;
    border: 1px solid #e4e4e7 !important;
    border-radius: 12px !important;
    box-shadow: none !important;
  }
  .swagger-ui .servers-title { color: #09090b !important; }
  .swagger-ui .servers > label { color: #71717a !important; }
  .swagger-ui .servers select, .swagger-ui select {
    background: #ffffff !important;
    color: #09090b !important;
    border: 1px solid #e4e4e7 !important;
    border-radius: 6px !important;
  }

  .swagger-ui .filter-container { background: transparent !important; }
  .swagger-ui .filter { background: transparent !important; }
  .swagger-ui input[type="text"], .swagger-ui .operation-filter-input {
    background: #ffffff !important;
    color: #09090b !important;
    border: 1px solid #e4e4e7 !important;
    border-radius: 8px !important;
  }
  .swagger-ui input::placeholder { color: #71717a !important; }
  .swagger-ui textarea {
    background: #ffffff !important;
    color: #09090b !important;
    border: 1px solid #e4e4e7 !important;
  }

  .swagger-ui .opblock-tag-section { background: transparent !important; }
  .swagger-ui .opblock-tag {
    color: #09090b !important;
    border-color: #e4e4e7 !important;
    background: transparent !important;
  }
  .swagger-ui .opblock-tag:hover { background: #f4f4f5 !important; }
  .swagger-ui .opblock-tag small { color: #71717a !important; }

  .swagger-ui .opblock {
    background: #ffffff !important;
    border-radius: 8px !important;
    box-shadow: none !important;
  }
  .swagger-ui .opblock .opblock-summary { background: transparent !important; }
  .swagger-ui .opblock .opblock-summary-path,
  .swagger-ui .opblock .opblock-summary-path span { color: #09090b !important; }
  .swagger-ui .opblock .opblock-summary-description { color: #71717a !important; }

  .swagger-ui .opblock.opblock-get {
    background: rgba(16, 185, 129, 0.05) !important;
    border: 1px solid rgba(16, 185, 129, 0.5) !important;
  }
  .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #10b981 !important; }

  .swagger-ui .opblock.opblock-post {
    background: rgba(59, 130, 246, 0.05) !important;
    border: 1px solid rgba(59, 130, 246, 0.5) !important;
  }
  .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #3b82f6 !important; }

  .swagger-ui .opblock.opblock-put {
    background: rgba(245, 158, 11, 0.05) !important;
    border: 1px solid rgba(245, 158, 11, 0.5) !important;
  }
  .swagger-ui .opblock.opblock-put .opblock-summary-method { background: #f59e0b !important; }

  .swagger-ui .opblock.opblock-delete {
    background: rgba(239, 68, 68, 0.05) !important;
    border: 1px solid rgba(239, 68, 68, 0.5) !important;
  }
  .swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #ef4444 !important; }

  .swagger-ui .opblock-summary-method { font-weight: 600 !important; border-radius: 4px !important; }

  .swagger-ui .opblock-body { background: #ffffff !important; }
  .swagger-ui .opblock-body pre { background: #f4f4f5 !important; color: #09090b !important; }
  .swagger-ui .opblock-section-header { background: #f4f4f5 !important; box-shadow: none !important; }
  .swagger-ui .opblock-section-header h4, .swagger-ui .opblock-section-header label { color: #09090b !important; }
  .swagger-ui .opblock-description-wrapper, .swagger-ui .opblock-description-wrapper p { color: #71717a !important; }

  .swagger-ui table { background: transparent !important; }
  .swagger-ui table thead tr td, .swagger-ui table thead tr th { color: #71717a !important; border-color: #e4e4e7 !important; }
  .swagger-ui table tbody tr td { color: #09090b !important; border-color: #e4e4e7 !important; }
  .swagger-ui .parameters-col_description { color: #71717a !important; }

  .swagger-ui .parameter__name { color: #8b5cf6 !important; }
  .swagger-ui .parameter__type, .swagger-ui .parameter__in { color: #71717a !important; }

  .swagger-ui .tab li { color: #71717a !important; }
  .swagger-ui .tab li.active { color: #09090b !important; }

  .swagger-ui .responses-wrapper, .swagger-ui .responses-inner,
  .swagger-ui .responses-table, .swagger-ui .response { background: transparent !important; }
  .swagger-ui .responses-inner h4 { color: #09090b !important; }
  .swagger-ui .response-col_status { color: #09090b !important; }
  .swagger-ui .response-col_description { color: #71717a !important; }

  .swagger-ui section.models {
    border: 1px solid #e4e4e7 !important;
    border-radius: 8px !important;
    background: transparent !important;
  }
  .swagger-ui section.models h4 { color: #09090b !important; border-color: #e4e4e7 !important; }
  .swagger-ui section.models .model-container { background: #ffffff !important; }
  .swagger-ui .model-title { color: #09090b !important; }
  .swagger-ui .model { color: #71717a !important; }
  .swagger-ui .model .property.primitive { color: #10b981 !important; }
  .swagger-ui .model-box { background: #ffffff !important; }

  .swagger-ui .btn { border-radius: 6px !important; }
  .swagger-ui .btn.execute { background: #8b5cf6 !important; border-color: #8b5cf6 !important; color: white !important; }
  .swagger-ui .btn.execute:hover { background: #7c3aed !important; }
  .swagger-ui .btn.cancel, .swagger-ui .btn-group .btn {
    background: #f4f4f5 !important;
    border-color: #e4e4e7 !important;
    color: #09090b !important;
  }
  .swagger-ui .try-out, .swagger-ui .execute-wrapper { background: transparent !important; }
  .swagger-ui .try-out__btn { border-color: #e4e4e7 !important; color: #09090b !important; }

  .swagger-ui .authorization__btn { background: transparent !important; border: 1px solid #e4e4e7 !important; }
  .swagger-ui .authorization__btn:hover { background: #f4f4f5 !important; }
  .swagger-ui .authorization__btn svg, .swagger-ui .locked svg { fill: #09090b !important; }
  .swagger-ui .unlocked svg { fill: #71717a !important; }
  .swagger-ui .auth-wrapper { background: #ffffff !important; }
  .swagger-ui .auth-container h4 { color: #09090b !important; }

  .swagger-ui .dialog-ux .modal-ux { background: #ffffff !important; border: 1px solid #e4e4e7 !important; }
  .swagger-ui .dialog-ux .modal-ux-header { border-color: #e4e4e7 !important; }
  .swagger-ui .dialog-ux .modal-ux-header h3 { color: #09090b !important; }
  .swagger-ui .dialog-ux .modal-ux-content p, .swagger-ui .dialog-ux .modal-ux-content label { color: #71717a !important; }

  .swagger-ui .highlight-code, .swagger-ui .microlight { background: #f4f4f5 !important; border-radius: 8px !important; }
  .swagger-ui .highlight-code pre { background: transparent !important; }
  .swagger-ui .highlight-code code { color: #09090b !important; }
  .swagger-ui .copy-to-clipboard { background: #f4f4f5 !important; }
  .swagger-ui .example, .swagger-ui .body-param__text { background: #f4f4f5 !important; color: #09090b !important; }

  .swagger-ui a { color: #8b5cf6 !important; }
  .swagger-ui .expand-operation svg, .swagger-ui .arrow svg { fill: #71717a !important; }
  .swagger-ui .renderedMarkdown p { color: #71717a !important; }
  .swagger-ui .renderedMarkdown code { background: #f4f4f5 !important; color: #09090b !important; }

  /* ===== DARK MODE ===== */
  .dark .swagger-ui .info .title { color: #fafafa !important; }
  .dark .swagger-ui .info .description, .dark .swagger-ui .info .description p { color: #a1a1aa !important; }
  .dark .swagger-ui .info .base-url { color: #a1a1aa !important; }

  .dark .swagger-ui .scheme-container {
    background: #18181b !important;
    border: 1px solid #27272a !important;
  }
  .dark .swagger-ui .servers-title { color: #fafafa !important; }
  .dark .swagger-ui .servers > label { color: #a1a1aa !important; }
  .dark .swagger-ui .servers select, .dark .swagger-ui select {
    background: #0a0a0c !important;
    color: #fafafa !important;
    border: 1px solid #27272a !important;
  }

  .dark .swagger-ui input[type="text"], .dark .swagger-ui .operation-filter-input {
    background: #18181b !important;
    color: #fafafa !important;
    border: 1px solid #27272a !important;
  }
  .dark .swagger-ui input::placeholder { color: #a1a1aa !important; }
  .dark .swagger-ui textarea {
    background: #18181b !important;
    color: #fafafa !important;
    border: 1px solid #27272a !important;
  }

  .dark .swagger-ui .opblock-tag {
    color: #fafafa !important;
    border-color: #27272a !important;
  }
  .dark .swagger-ui .opblock-tag:hover { background: #27272a !important; }
  .dark .swagger-ui .opblock-tag small { color: #a1a1aa !important; }

  .dark .swagger-ui .opblock {
    background: #18181b !important;
  }
  .dark .swagger-ui .opblock .opblock-summary-path,
  .dark .swagger-ui .opblock .opblock-summary-path span { color: #fafafa !important; }
  .dark .swagger-ui .opblock .opblock-summary-description { color: #a1a1aa !important; }

  .dark .swagger-ui .opblock.opblock-get {
    background: rgba(16, 185, 129, 0.1) !important;
  }
  .dark .swagger-ui .opblock.opblock-post {
    background: rgba(59, 130, 246, 0.1) !important;
  }
  .dark .swagger-ui .opblock.opblock-put {
    background: rgba(245, 158, 11, 0.1) !important;
  }
  .dark .swagger-ui .opblock.opblock-delete {
    background: rgba(239, 68, 68, 0.1) !important;
  }

  .dark .swagger-ui .opblock-body { background: #0a0a0c !important; }
  .dark .swagger-ui .opblock-body pre { background: #18181b !important; color: #fafafa !important; }
  .dark .swagger-ui .opblock-section-header { background: #27272a !important; }
  .dark .swagger-ui .opblock-section-header h4, .dark .swagger-ui .opblock-section-header label { color: #fafafa !important; }
  .dark .swagger-ui .opblock-description-wrapper, .dark .swagger-ui .opblock-description-wrapper p { color: #a1a1aa !important; }

  .dark .swagger-ui table thead tr td, .dark .swagger-ui table thead tr th { color: #a1a1aa !important; border-color: #27272a !important; }
  .dark .swagger-ui table tbody tr td { color: #fafafa !important; border-color: #27272a !important; }
  .dark .swagger-ui .parameters-col_description { color: #a1a1aa !important; }

  .dark .swagger-ui .parameter__name { color: #a78bfa !important; }
  .dark .swagger-ui .parameter__type, .dark .swagger-ui .parameter__in { color: #a1a1aa !important; }

  .dark .swagger-ui .tab li { color: #a1a1aa !important; }
  .dark .swagger-ui .tab li.active { color: #fafafa !important; }

  .dark .swagger-ui .responses-inner h4 { color: #fafafa !important; }
  .dark .swagger-ui .response-col_status { color: #fafafa !important; }
  .dark .swagger-ui .response-col_description { color: #a1a1aa !important; }

  .dark .swagger-ui section.models { border-color: #27272a !important; }
  .dark .swagger-ui section.models h4 { color: #fafafa !important; border-color: #27272a !important; }
  .dark .swagger-ui section.models .model-container { background: #18181b !important; }
  .dark .swagger-ui .model-title { color: #fafafa !important; }
  .dark .swagger-ui .model { color: #a1a1aa !important; }
  .dark .swagger-ui .model-box { background: #18181b !important; }

  .dark .swagger-ui .btn.cancel, .dark .swagger-ui .btn-group .btn {
    background: #27272a !important;
    border-color: #27272a !important;
    color: #fafafa !important;
  }
  .dark .swagger-ui .try-out__btn { border-color: #27272a !important; color: #fafafa !important; }

  .dark .swagger-ui .authorization__btn { border-color: #27272a !important; }
  .dark .swagger-ui .authorization__btn:hover { background: #27272a !important; }
  .dark .swagger-ui .authorization__btn svg, .dark .swagger-ui .locked svg { fill: #fafafa !important; }
  .dark .swagger-ui .unlocked svg { fill: #a1a1aa !important; }
  .dark .swagger-ui .auth-wrapper { background: #18181b !important; }
  .dark .swagger-ui .auth-container h4 { color: #fafafa !important; }

  .dark .swagger-ui .dialog-ux .modal-ux { background: #18181b !important; border-color: #27272a !important; }
  .dark .swagger-ui .dialog-ux .modal-ux-header { border-color: #27272a !important; }
  .dark .swagger-ui .dialog-ux .modal-ux-header h3 { color: #fafafa !important; }
  .dark .swagger-ui .dialog-ux .modal-ux-content p, .dark .swagger-ui .dialog-ux .modal-ux-content label { color: #a1a1aa !important; }

  .dark .swagger-ui .highlight-code, .dark .swagger-ui .microlight { background: #18181b !important; }
  .dark .swagger-ui .highlight-code code { color: #fafafa !important; }
  .dark .swagger-ui .copy-to-clipboard { background: #27272a !important; }
  .dark .swagger-ui .example, .dark .swagger-ui .body-param__text { background: #18181b !important; color: #fafafa !important; }

  .dark .swagger-ui .expand-operation svg, .dark .swagger-ui .arrow svg { fill: #a1a1aa !important; }
  .dark .swagger-ui .renderedMarkdown p { color: #a1a1aa !important; }
  .dark .swagger-ui .renderedMarkdown code { background: #18181b !important; color: #fafafa !important; }
`

export default function ApiReferencePage() {
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return

    const initSwagger = () => {
      if (window.SwaggerUIBundle && window.SwaggerUIStandalonePreset) {
        initialized.current = true
        window.SwaggerUIBundle({
          url: '/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [
            (window.SwaggerUIBundle as unknown as { presets: { apis: unknown } }).presets?.apis,
            window.SwaggerUIStandalonePreset,
          ],
          layout: 'StandaloneLayout',
          defaultModelsExpandDepth: 1,
          defaultModelExpandDepth: 1,
          docExpansion: 'list',
          filter: true,
          showExtensions: true,
          showCommonExtensions: true,
          tryItOutEnabled: true,
        })
      }
    }

    if (typeof window.SwaggerUIBundle !== 'undefined') {
      initSwagger()
    }

    const handleLoad = () => initSwagger()
    window.addEventListener('swagger-loaded', handleLoad)
    return () => window.removeEventListener('swagger-loaded', handleLoad)
  }, [])

  return (
    <>
      <link
        rel="stylesheet"
        href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css"
      />
      <Script
        src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"
        strategy="afterInteractive"
        onLoad={() => {
          window.dispatchEvent(new Event('swagger-loaded'))
        }}
      />
      <Script
        src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js"
        strategy="afterInteractive"
        onLoad={() => {
          window.dispatchEvent(new Event('swagger-loaded'))
        }}
      />
      <style dangerouslySetInnerHTML={{ __html: swaggerStyles }} />

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div id="swagger-ui" />
      </div>
    </>
  )
}
