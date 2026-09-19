/**
 * A package installed beside Studio, for the seam's own test.
 *
 * It is plain JavaScript with no imports of Studio's internals: at boot the app loads it and hands
 * it the registration function, which is the one thing an installed package needs. The declaration
 * below is the whole of what it does.
 */
export function register(api) {
  api.registerModule({
    key: 'fixture_notes',
    name: 'Fixture notes',
    sentence: 'A part of Studio that an installed package declares, used only to prove the seam.',
    permissions: [],
    menu: [],
    hides: 'nothing: it is a fixture',
    needs: [],
    built: true,
  });
}
