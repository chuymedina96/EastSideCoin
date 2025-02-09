import { createNavigationContainerRef, CommonActions } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

// ✅ Function to navigate
export function navigate(name, params) {
  if (navigationRef.isReady()) {
    console.log(`🚀 Navigating to ${name}`);
    navigationRef.navigate(name, params);
  } else {
    console.warn("⚠️ NavigationRef is not ready");
  }
}

// ✅ Function to reset navigation stack
export function resetNavigation(name) {
  if (navigationRef.isReady()) {
    console.log(`🚀 Resetting Navigation to ${name}`);
    navigationRef.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name }],
      })
    );
  } else {
    console.warn("⚠️ NavigationRef is not ready");
  }
}
