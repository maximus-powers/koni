# Homebrew preparation

The checked-in formula is intentionally `head`-only until Köni has a tagged
release. Maintainers can exercise it without publishing a tap:

```sh
brew install --HEAD ./packaging/homebrew/koni.rb
brew test koni
```

For the first stable release, replace `head` with the tagged GitHub source
archive and its SHA-256, run `brew audit --strict koni`, and submit the formula
to Homebrew/core. Do not document `brew install koni` as available until that
submission is accepted.
