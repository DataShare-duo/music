// Compatibility entry for the first verification build
import { openHome } from "../../routes";
Page({
  onLoad() {
    openHome();
  },
  retry() {
    openHome();
  },
});
