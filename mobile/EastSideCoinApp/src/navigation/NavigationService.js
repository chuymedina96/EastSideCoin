// navigation/NavigationService.js
import { createNavigationContainerRef, CommonActions, StackActions } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

const MAX_QUEUE = 20;
const pendingActions = [];
let lastActionSig = null;
let lastActionSigExpiry = 0;
let _ready = false;

// ----- Utils -----
const defer = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function dedupeGuard(signature, cooldownMs = 750) {
  const now = Date.now();
  if (lastActionSig === signature && now < lastActionSigExpiry) return true;
  lastActionSig = signature;
  lastActionSigExpiry = now + cooldownMs;
  return false;
}

function enqueueOrDispatch(action) {
  const sig = JSON.stringify(action?.payload ?? action);
  if (dedupeGuard(sig)) return false;

  if (!_ready || !navigationRef.isReady()) {
    if (pendingActions.length >= MAX_QUEUE) pendingActions.shift();
    pendingActions.push(action);
    return false;
  }
  navigationRef.dispatch(action);
  return true;
}

// ----- Route existence check -----
function stateHasRoute(state, targetName) {
  if (!state) return false;
  const { routes = [] } = state;
  for (const r of routes) {
    if (r.name === targetName) return true;
    if (r.state && stateHasRoute(r.state, targetName)) return true;
  }
  return false;
}

function routeExists(targetName) {
  if (!_ready || !navigationRef.isReady()) return false;
  const root = navigationRef.getRootState?.();
  return stateHasRoute(root, targetName);
}

// ----- Public API -----
export function onNavReady() {
  _ready = true;
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

export async function waitUntilReady(timeoutMs = 3000) {
  const t0 = Date.now();
  while (!_ready || !navigationRef.isReady()) {
    if (Date.now() - t0 > timeoutMs) break;
    // 1 frame or 16ms
    await defer(16);
  }
  return _ready && navigationRef.isReady();
}

export function resetNavigation(routeName, params) {
  // If ready and target not in tree, fall back to navigate (prevents warnings)
  if (_ready && navigationRef.isReady() && !routeExists(routeName)) {
    console.warn(`⚠️ resetNavigation("${routeName}") not in current tree → navigate() fallback`);
    return navigate(routeName, params);
  }

  const action = CommonActions.reset({
    index: 0,
    routes: [{ name: routeName, params }],
  });

  console.log(`🚀 Resetting Navigation to ${routeName}`);
  enqueueOrDispatch(action);
}

export function navigate(routeName, params = {}) {
  // If ready and target not in tree, just log + no-op (prevents RN warning spam)
  if (_ready && navigationRef.isReady() && !routeExists(routeName)) {
    console.warn(`⚠️ navigate("${routeName}") not in current tree → no-op`);
    return;
  }
  const action = CommonActions.navigate({ name: routeName, params });
  console.log(`📡 Navigating to ${routeName}`);
  enqueueOrDispatch(action);
}

export function push(routeName, params = {}) {
  // Same protection as navigate
  if (_ready && navigationRef.isReady() && !routeExists(routeName)) {
    console.warn(`⚠️ push("${routeName}") not in current tree → no-op`);
    return;
  }
  const action = StackActions.push(routeName, params);
  enqueueOrDispatch(action);
}

export function goBack() {
  if (_ready && navigationRef.isReady() && navigationRef.canGoBack()) {
    navigationRef.goBack();
  }
}

export function canGoBack() {
  return _ready && navigationRef.isReady() && navigationRef.canGoBack();
}

export function getCurrentRoute() {
  if (!_ready || !navigationRef.isReady()) return null;
  return navigationRef.getCurrentRoute?.() || null;
}

// Opinionated helpers
export const resetToAuth     = (params) => resetNavigation("Login", params);        // or "Landing"
export const resetToApp      = (params) => resetNavigation("HomeTabs", params);
export const resetToKeySetup = (params) => resetNavigation("KeyScreenSetup", params);
