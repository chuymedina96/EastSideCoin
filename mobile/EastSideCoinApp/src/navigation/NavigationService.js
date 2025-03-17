import { createNavigationContainerRef, CommonActions } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

/**
 * Reset navigation stack to a specific route.
 */
export function resetNavigation(routeName) {
  if (!navigationRef.isReady()) {
    console.warn(`⚠️ Navigation is NOT ready! Skipping reset to ${routeName}.`);
    return;
  }

  console.log(`🚀 Resetting Navigation to ${routeName}`);

  navigationRef.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: routeName }],
    })
  );
}

/**
 * Navigate to a specific route.
 */
export function navigate(routeName, params = {}) {
  if (!navigationRef.isReady()) {
    console.warn(`⚠️ Navigation is NOT ready! Skipping navigation to ${routeName}.`);
    return;
  }

  console.log(`📡 Navigating to ${routeName}`);

  navigationRef.dispatch(
    CommonActions.navigate({
      name: routeName,
      params,
    })
  );
}
