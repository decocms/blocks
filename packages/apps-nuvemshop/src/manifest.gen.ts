// Hand-maintained (the generate-manifests script referenced by other apps doesn't exist).
// Keys are the `__resolveType` / `/deco/invoke/<key>` names.

import * as actions_account_login from "./actions/account/login";
import * as actions_account_logout from "./actions/account/logout";
import * as actions_account_register from "./actions/account/register";
import * as actions_createCheckout from "./actions/createCheckout";
import * as loaders_categories from "./loaders/categories";
import * as loaders_productDetailsPage from "./loaders/productDetailsPage";
import * as loaders_productList from "./loaders/productList";
import * as loaders_productListingPage from "./loaders/productListingPage";
import * as loaders_relatedProducts from "./loaders/relatedProducts";
import * as loaders_shippingOptions from "./loaders/shippingOptions";
import * as loaders_suggestions from "./loaders/suggestions";
import * as loaders_user from "./loaders/user";

const manifest = {
  name: "nuvemshop",
  loaders: {
    "nuvemshop/loaders/categories": loaders_categories,
    "nuvemshop/loaders/productDetailsPage": loaders_productDetailsPage,
    "nuvemshop/loaders/productList": loaders_productList,
    "nuvemshop/loaders/productListingPage": loaders_productListingPage,
    "nuvemshop/loaders/relatedProducts": loaders_relatedProducts,
    "nuvemshop/loaders/shippingOptions": loaders_shippingOptions,
    "nuvemshop/loaders/suggestions": loaders_suggestions,
    "nuvemshop/loaders/user": loaders_user,
  },
  actions: {
    "nuvemshop/actions/account/login": actions_account_login,
    "nuvemshop/actions/account/logout": actions_account_logout,
    "nuvemshop/actions/account/register": actions_account_register,
    "nuvemshop/actions/createCheckout": actions_createCheckout,
  },
  sections: {},
} as const;

export type Manifest = typeof manifest;
export default manifest;
