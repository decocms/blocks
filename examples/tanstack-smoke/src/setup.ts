import { createSiteSetup } from "@decocms/runtime/setup";
import { createAdminSetup } from "@decocms/admin/setup";
import { setupTanstackFastDeploy } from "@decocms/tanstack";

createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx"),
  blocks: {},
});

createAdminSetup({
  meta: () => Promise.resolve({}),
  css: "",
});

setupTanstackFastDeploy();
