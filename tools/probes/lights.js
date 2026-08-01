const out = [];
g.engine.scene.traverse((o) => {
  if (o.isLight) out.push({ type: o.type, name: o.name, intensity: o.intensity, visible: o.visible,
    color: [o.color?.r, o.color?.g, o.color?.b], pos: [o.position.x, o.position.y, o.position.z].map(v=>+v.toFixed(1)) });
});
return { lights: out, envIntensity: g.engine.scene.environmentIntensity, hasEnv: !!g.engine.scene.environment };
