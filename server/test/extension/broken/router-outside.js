import express from 'express';

/** A package that tries to name its own address rather than a segment under the namespace. */
export function register(api) {
  api.registerRouter('../settings', express.Router());
}
