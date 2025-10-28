// navigation/NavigationService.js
import { createNavigationContainerRef, CommonActions } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

// ---------------- Queue + dedupe ----------------
const MAX_QUEUE = 20;
const pendingActions = [];
let lastActionSig = null;
let lastActionSigExpiry = 0;

/**
 * Call once at the root:
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

function dedupeGuard(signature, cooldownMs = 750) {
  const now = Date.now();
  if (lastActionSig === signature && now < lastActionSigExpiry) return true; // duplicate → ignore
  lastActionSig = signature;
  lastActionSigExpiry = now + cooldownMs;
  return false;
}

function enqueueOrDispatch(action) {
  const sig = JSON.stringify(action?.payload ?? action);
  if (dedupeGuard(sig)) return false;

  if (!navigationRef.isReady()) {
    if (pendingActions.length >= MAX_QUEUE) pendingActions.shift(); // drop oldest
    pendingActions.push(action);
    return false;
  }
  navigationRef.dispatch(action);
  return true;
}

// --------------- Route existence check ---------------
function stateHasRoute(state, targetName) {
  if (!state) return false;
  const { routes = [] } = state;
  for (const r of routes) {
    if (r.name === targetName) return true;
    if (r.state && stateHasRoute(r.state, targetName)) return true;
  }
  return false;
}

// --------------- Public API ----------------
/**
 * Safer reset:
 * - Validates route exists in current tree.
 * - Falls back to navigate() if it doesn't (prevents warnings).
 * - Dedupes rapid identical calls.
 */
export function resetNavigation(routeName, params) {
  const action = CommonActions.reset({
    index: 0,
    routes: [{ name: routeName, params }],
  });

  if (navigationRef.isReady()) {
    const root = navigationRef.getRootState?.();
    if (root && !stateHasRoute(root, routeName)) {
      console.warn(
        `⚠️ resetNavigation("${routeName}") is not in the mounted navigator tree. Falling back to navigate().`
      );
      return navigate(routeName, params);
    }
  } else {
    // Not ready yet — still enqueue the reset; it will run after onNavReady.
  }

  console.log(`🚀 Resetting Navigation to ${routeName}`);
  enqueueOrDispatch(action);
}

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

// Opinionated helpers for common flows
export const resetToAuth     = (params) => resetNavigation("Login", params);        // or "Landing" for your auth entry
export const resetToApp      = (params) => resetNavigation("HomeTabs", params);
export const resetToKeySetup = (params) => resetNavigation("KeyScreenSetup", params);
