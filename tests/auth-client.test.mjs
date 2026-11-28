import { test } from "node:test";
import assert from "node:assert/strict";
import { apiFailure } from "../public/auth-errors.js";

test("une réponse 401 du login conserve l’erreur d’identifiants du serveur", () => {
  assert.deepEqual(
    apiFailure("/api/login", false, 401, { error: "Identifiants invalides." }),
    { message: "Identifiants invalides.", requiresLogin: false },
  );
});

test("un 401 sur une route protégée demande une nouvelle connexion", () => {
  assert.deepEqual(
    apiFailure("/api/state", false, 401, { error: "Unauthorized" }),
    { message: "Session expirée", requiresLogin: true },
  );
});

test("les autres erreurs HTTP gardent le message du serveur", () => {
  assert.deepEqual(
    apiFailure("/api/login", false, 500, { error: "Service indisponible." }),
    { message: "Service indisponible.", requiresLogin: false },
  );
});

test("une réponse réussie ne produit pas d’erreur", () => {
  assert.equal(apiFailure("/api/login", true, 200, { user: "admin" }), null);
});
