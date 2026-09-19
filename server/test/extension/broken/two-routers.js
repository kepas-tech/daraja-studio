import express from 'express';

/** A package that asks for two routers. One is the promise, so the second stops the boot. */
export function register(api) {
  api.registerRouter('first', express.Router());
  api.registerRouter('second', express.Router());
}
