import { CommonActions } from "@react-navigation/native";

let navigator;

export function setNavigator(nav) {
  navigator = nav;
}

export function navigate(name, params) {
  if (navigator) {
    navigator.dispatch(
      CommonActions.navigate({
        name,
        params,
      })
    );
  }
}

export function resetNavigation(name) {
  if (navigator) {
    navigator.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name }],
      })
    );
  }
}
