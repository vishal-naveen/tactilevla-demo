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
