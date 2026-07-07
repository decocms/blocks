import { createSiteSetup } from "@decocms/blocks/setup";
import { createAdminSetup } from "@decocms/blocks-admin/setup";
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
