// navigation/NavigationService.js
import { createNavigationContainerRef, CommonActions } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

// ---- Queue + dedupe ---------------------------------------------------------
const MAX_QUEUE = 20;
const pendingActions = [];
let lastActionKey = "";

/**
 * Call once in App root:
 * <NavigationContainer ref={navigationRef} onReady={onNavReady}>...</NavigationContainer>
 */
export function onNavReady() {
  const flush = () => {
    while (pendingActions.length) {
      const act = pendingActions.shift();
      try {
        navigationRef.dispatch(act);
      } catch (e) {
        console.warn("⚠️ Deferred nav dispatch failed:", e?.message || e);
      }
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 0);
}

function enqueueOrDispatch(action) {
  // Prevent rapid duplicate dispatches that can cause flicker
  const key = JSON.stringify(action?.payload ?? action);
  if (key === lastActionKey) return false;
  lastActionKey = key;

  if (!navigationRef.isReady()) {
    if (pendingActions.length >= MAX_QUEUE) pendingActions.shift(); // drop oldest
    pendingActions.push(action);
    return false;
  }
  navigationRef.dispatch(action);
  return true;
}

// ---- Route existence check ---------------------------------------------------
function stateHasRoute(state, targetName) {
  if (!state) return false;
  const { routes = [] } = state;
  for (const r of routes) {
    if (r.name === targetName) return true;
    if (r.state && stateHasRoute(r.state, targetName)) return true;
  }
  return false;
}

// ---- Public API --------------------------------------------------------------
/** Safer reset with route existence warning */
export function resetNavigation(routeName, params) {
  const action = CommonActions.reset({
    index: 0,
    routes: [{ name: routeName, params }],
  });

  if (navigationRef.isReady()) {
    const root = navigationRef.getRootState?.();
    if (root && !stateHasRoute(root, routeName)) {
      console.warn(
        `⚠️ resetNavigation("${routeName}") is not in the mounted navigator tree. ` +
          `Ensure this route exists in the current stack/tab.`
      );
    }
  }

  console.log(`🚀 Resetting Navigation to ${routeName}`);
  enqueueOrDispatch(action);
}

/** Regular navigate (queued if not ready) */
export function navigate(routeName, params = {}) {
  const action = CommonActions.navigate({ name: routeName, params });
  console.log(`📡 Navigating to ${routeName}`);
  enqueueOrDispatch(action);
}

export function goBack() {
  if (navigationRef.isReady() && navigationRef.canGoBack()) {
    navigationRef.goBack();
  }
}

export function canGoBack() {
  return navigationRef.isReady() && navigationRef.canGoBack();
}

// Opinionated helpers for your flows
export const resetToAuth     = () => resetNavigation("Login");
export const resetToApp      = () => resetNavigation("HomeTabs");
export const resetToKeySetup = () => resetNavigation("KeyScreenSetup");
