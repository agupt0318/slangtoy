// Built-in shaders. Each one is a complete, standalone Slang file: the uniform
// block is repeated rather than injected so the line numbers in the editor match
// the line numbers the compiler reports.

export type Example = { id: string; label: string; source: string };

const UNIFORMS = `struct Uniforms
{
    float4 mouse;       // xy: cursor while pressed, zw: last press (negated when up)
    float2 resolution;  // canvas size in pixels
    float  time;        // seconds since the shader started
    uint   frame;       // frames drawn
};
ConstantBuffer<Uniforms> u;
`;

/** Normalized, y-up pixel coords, the way Shadertoy hands them to you. */
const UV = `    // WebGPU puts y at the top, so flip it for Shadertoy-style coords.
    float2 uv = fragCoord.xy / u.resolution;
    uv.y = 1.0 - uv.y;`;

export const EXAMPLES: Example[] = [
  {
    id: 'gradient',
    label: 'gradient',
    source: `${UNIFORMS}
[shader("fragment")]
float4 imageMain(float4 fragCoord : SV_Position) : SV_Target
{
${UV}

    float3 phase = float3(0.0, 2.0, 4.0);
    float3 color = 0.5 + 0.5 * cos(u.time + (uv.x + uv.y) * 6.0 + phase);
    return float4(color, 1.0);
}
`,
  },
  {
    id: 'plasma',
    label: 'plasma',
    source: `${UNIFORMS}
[shader("fragment")]
float4 imageMain(float4 fragCoord : SV_Position) : SV_Target
{
${UV}

    float2 p = (uv - 0.5) * 6.0;
    float t = u.time * 0.6;

    // Four interfering waves: two axis-aligned, one diagonal, one radial.
    float v = sin(p.x + t)
            + sin(p.y + t)
            + sin(p.x + p.y + t)
            + sin(length(p) * 2.0 - t);

    float3 color = 0.5 + 0.5 * cos(v * 1.4 + float3(0.0, 2.1, 4.2));
    return float4(color, 1.0);
}
`,
  },
  {
    id: 'mandelbrot',
    label: 'mandelbrot',
    source: `${UNIFORMS}
static const int MAX_ITER = 200;

[shader("fragment")]
float4 imageMain(float4 fragCoord : SV_Position) : SV_Target
{
${UV}

    float breathe = sin(u.time * 0.15);
    float zoom = 2.4 - 2.0 * breathe * breathe;
    float aspect = u.resolution.x / u.resolution.y;
    float2 c = (uv - 0.5) * float2(aspect, 1.0) * zoom + float2(-0.75, 0.0);

    float2 z = float2(0.0, 0.0);
    int i = 0;
    for (; i < MAX_ITER; ++i)
    {
        // z = z^2 + c, with complex multiplication written out.
        z = float2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 16.0)
            break;
    }

    if (i == MAX_ITER)
        return float4(0.02, 0.02, 0.04, 1.0);

    // Smooth the iteration count so the bands do not stair-step.
    float m = float(i) - log2(log2(dot(z, z)) * 0.5);
    float3 color = 0.5 + 0.5 * cos(m * 0.25 + float3(0.0, 0.6, 1.1));
    return float4(color, 1.0);
}
`,
  },
  {
    id: 'raymarch',
    label: 'raymarched sphere',
    source: `${UNIFORMS}
float sceneSdf(float3 p, float time)
{
    float3 q = p;
    q.y += sin(time) * 0.25;
    float sphere = length(q) - 1.0;
    float ground = p.y + 1.2;
    return min(sphere, ground);
}

float3 sceneNormal(float3 p, float time)
{
    float e = 0.002;
    float3 n = float3(
        sceneSdf(p + float3(e, 0.0, 0.0), time) - sceneSdf(p - float3(e, 0.0, 0.0), time),
        sceneSdf(p + float3(0.0, e, 0.0), time) - sceneSdf(p - float3(0.0, e, 0.0), time),
        sceneSdf(p + float3(0.0, 0.0, e), time) - sceneSdf(p - float3(0.0, 0.0, e), time));
    return normalize(n);
}

[shader("fragment")]
float4 imageMain(float4 fragCoord : SV_Position) : SV_Target
{
${UV}

    float aspect = u.resolution.x / u.resolution.y;
    float2 p = (uv - 0.5) * float2(aspect, 1.0) * 2.0;

    float3 ro = float3(0.0, 0.0, -3.5);
    float3 rd = normalize(float3(p, 1.5));

    // March until the distance field says we are basically touching a surface.
    float t = 0.0;
    bool hit = false;
    for (int i = 0; i < 96; ++i)
    {
        float d = sceneSdf(ro + rd * t, u.time);
        if (d < 0.001) { hit = true; break; }
        if (t > 20.0) break;
        t += d;
    }

    float3 color = float3(0.05, 0.06, 0.09);
    if (hit)
    {
        float3 pos = ro + rd * t;
        float3 n = sceneNormal(pos, u.time);
        float3 lightDir = normalize(float3(0.6, 0.8, -0.4));
        float diffuse = max(dot(n, lightDir), 0.0);
        color = float3(0.95, 0.5, 0.22) * (0.15 + diffuse);
    }
    return float4(color, 1.0);
}
`,
  },
  {
    id: 'voronoi',
    label: 'voronoi',
    source: `${UNIFORMS}
float2 hash2(float2 p)
{
    p = float2(dot(p, float2(127.1, 311.7)), dot(p, float2(269.5, 183.3)));
    return frac(sin(p) * 43758.5453);
}

[shader("fragment")]
float4 imageMain(float4 fragCoord : SV_Position) : SV_Target
{
${UV}

    float2 p = uv * 6.0;
    float2 cell = floor(p);
    float2 f = p - cell;

    // Check the 3x3 neighborhood for the closest drifting seed point.
    float best = 8.0;
    float2 bestId = float2(0.0, 0.0);
    for (int y = -1; y <= 1; ++y)
    {
        for (int x = -1; x <= 1; ++x)
        {
            float2 offset = float2(float(x), float(y));
            float2 id = hash2(cell + offset);
            float2 pt = offset + 0.5 + 0.5 * sin(u.time + 6.2831 * id);
            float d = length(pt - f);
            if (d < best)
            {
                best = d;
                bestId = id;
            }
        }
    }

    float3 color = 0.5 + 0.5 * cos(bestId.x * 6.0 + float3(0.0, 1.8, 3.4));
    return float4(color * (0.35 + 0.9 * best), 1.0);
}
`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
