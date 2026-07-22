// Thin re-export so `eslint .` resolves correctly when Turbo runs this
// package's lint script from the package directory.
import rootConfig from '../../eslint.config.mjs';

export default rootConfig;
