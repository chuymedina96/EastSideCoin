import { CommonActions } from "@react-navigation/native";

let navigator;

export function setNavigator(nav) {
  navigator = nav;
}

export function resetNavigation(name) {
  if (!navigator) {
    console.warn(`⚠️ Navigation is NOT initialized! Cannot navigate to ${name}.`);
    return;
  }

  if (navigator.isReady()) {
    console.log(`🚀 Resetting Navigation to ${name}`);
    navigator.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name }],
      })
    );
  } else {
    console.warn(`⚠️ Navigation is NOT ready yet! Cannot navigate to ${name}.`);
  }
}
