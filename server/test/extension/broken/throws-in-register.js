// A fixture package that loads and then refuses to register its declarations.
export function register() {
  throw new Error('the fixture package refused to register');
}
