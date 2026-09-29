// "Stacked" = the text sits under (or over the lower part of) the 3D instead of in a column on the left: phones and
// portrait tablets. THE predicate for page and stage. The CSS media queries spell out exactly STACKED_QUERY (grep
// "orientation: portrait) and (max-width: 1100px)" in css/); JS asks isStacked / matchMedia(STACKED_QUERY). Change all together.
export const STACK_MAX_W = 820          // any window this narrow stacks, whatever the aspect
export const STACK_PORTRAIT_MAX_W = 1100 // portrait windows up to here stack too (iPad Mini .. iPad Pro 12.9 portrait)
export const STACKED_QUERY = `(max-width: ${STACK_MAX_W}px), (orientation: portrait) and (max-width: ${STACK_PORTRAIT_MAX_W}px)`
export const isStacked = (w, h) => w <= STACK_MAX_W || (h >= w && w <= STACK_PORTRAIT_MAX_W)
// Tablet tier of the stacked layout: roomy type and panels (css: the "Portrait tablets" blocks). Needs >= 700 px of height so a
// landscape phone (600-820 wide, ~400 tall) stays on the phone sizes.
export const TABLET_STACKED_QUERY = '(min-width: 600px) and (max-width: 820px) and (min-height: 700px), (orientation: portrait) and (min-width: 821px) and (max-width: 1100px)'
export const isTabletStacked = (w, h) => isStacked(w, h) && w >= 600 && h >= 700

// The owner's iPad: landscape 11-inch tablets (1180x820 / 1180x796 CSS px, aspect ~1.44-1.48) as a Home Screen app. The side layout is
// tight there (text column ~620 px, scene ~520 px), so the stage tunes its framing, camera lean and phase words for exactly this range.
// CSS mirror: IPAD_LANDSCAPE_QUERY (css/tour.css). Desktop (>= 1300 px wide) and phones are untouched.
export const IPAD_LANDSCAPE_QUERY = '(min-width: 1100px) and (max-width: 1290px) and (min-height: 700px) and (max-height: 900px)'
export const isIpadLandscape = (w, h) => w >= 1100 && w <= 1290 && h >= 700 && h <= 900
