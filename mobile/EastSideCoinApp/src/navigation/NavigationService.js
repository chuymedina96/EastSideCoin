import { CommonActions } from "@react-navigation/native";

let navigator;

export function setNavigator(nav) {
  navigator = nav;
}

export function resetNavigation(routeName) {
  if (!navigator) {
    console.warn(`⚠️ Navigation is NOT initialized! Cannot navigate to ${routeName}.`);
    return;
  }

  if (navigator.isReady()) {
    console.log(`🚀 Resetting Navigation to ${routeName}`);

    navigator.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: "HomeTabs", params: { screen: routeName } }],
      })
    );
  } else {
    console.warn(`⚠️ Navigation is NOT ready yet! Cannot navigate to ${routeName}.`);
  }
}
