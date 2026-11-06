/**
 * dsh-market-info — Client (browser) half.
 *
 * Contributes a sidebar entry ("资讯") and a main-slot panel. The panel itself
 * is a same-origin iframe served by the Host route /market-info/ui, which keeps this
 * module tiny (no build tooling, no JSX) while the Host keeps full control over
 * the UI and data.
 */
window.__ModuleLoader__.load({
  id: 'dsh-market-info',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'dsh-market-info'
    const UI_URL = '/market-info/ui'

    function MarketIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      const active = props.active === true
      const color = active ? 'var(--dsw-alias-accent, #0a6cff)' : 'currentColor'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false', style: { display: 'block' } },
        h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2, stroke: color, strokeWidth: 1.6 }),
        h('path', { d: 'M7 9h10M7 12h10M7 15h6', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('rect', { x: 15.4, y: 14.2, width: 3, height: 3, rx: 0.6, fill: active ? 'var(--dsw-alias-accent, #0a6cff)' : 'currentColor' }),
      )
    }

    function MarketPanel() {
      return h('iframe', {
        src: UI_URL,
        title: '市场资讯',
        style: { display: 'block', width: '100%', height: '100%', minHeight: '70vh', border: '0', background: 'transparent' },
      })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: function () {
                return '市场资讯'
              },
            },
            MarketIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            MarketPanel,
          )
        })
      },
    }
  },
})
