"use client";

import { useEffect, useRef, useState } from "react";
import type { BufferGeometry, Material, Mesh, Object3D, Skeleton, Texture } from "three";
import { Box, Download } from "lucide-react";
import { assetUrlFor } from "@/lib/cabinets/asset-url";
import { sanitizeModelAssetUrl } from "@/lib/models/asset-url";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { ToolbarButton } from "@/components/layout/toolbar-button";

interface ModelCanvasProps {
  src: string;
  title?: string;
  className?: string;
}

export function ModelCanvas({ src, title = "3D model", className }: ModelCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const safeSrc = sanitizeModelAssetUrl(src);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !safeSrc) {
      setLoading(false);
      setError("This model URL is not allowed.");
      return;
    }

    let disposed = false;
    let cleanup = () => {};
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const THREE = await import("three");
        const [{ GLTFLoader }, { OrbitControls }] = await Promise.all([
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/controls/OrbitControls.js"),
        ]);
        if (disposed) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x171717);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        let controls: InstanceType<typeof OrbitControls> | null = null;
        let frame: number | null = null;
        let resizeObserver: ResizeObserver | null = null;
        let modelRoot: Object3D | null = null;
        let cleaned = false;
        const disposeObject = (root: Object3D) => {
          const geometries = new Set<BufferGeometry>();
          const materials = new Set<Material>();
          const textures = new Set<Texture>();
          const skeletons = new Set<Skeleton>();
          root.traverse((object) => {
            const mesh = object as Mesh;
            if (mesh.geometry) geometries.add(mesh.geometry);
            const meshMaterials = mesh.material
              ? Array.isArray(mesh.material)
                ? mesh.material
                : [mesh.material]
              : [];
            for (const material of meshMaterials) {
              materials.add(material);
              for (const value of Object.values(material)) {
                if (value instanceof THREE.Texture) textures.add(value);
              }
            }
            const skeleton = (object as Object3D & { skeleton?: Skeleton }).skeleton;
            if (skeleton) skeletons.add(skeleton);
          });
          for (const texture of textures) texture.dispose();
          for (const material of materials) material.dispose();
          for (const geometry of geometries) geometry.dispose();
          for (const skeleton of skeletons) skeleton.dispose();
        };
        const cleanupResources = () => {
          if (cleaned) return;
          cleaned = true;
          if (frame !== null) window.cancelAnimationFrame(frame);
          resizeObserver?.disconnect();
          controls?.dispose();
          if (modelRoot) disposeObject(modelRoot);
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };
        cleanup = cleanupResources;

        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1;
        mount.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.screenSpacePanning = true;

        scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2.5));
        const keyLight = new THREE.DirectionalLight(0xffffff, 3);
        keyLight.position.set(4, 6, 5);
        scene.add(keyLight);

        const gltf = await new GLTFLoader().loadAsync(safeSrc);
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        modelRoot = gltf.scene;
        scene.add(modelRoot);

        const bounds = new THREE.Box3().setFromObject(modelRoot);
        if (bounds.isEmpty()) throw new Error("The model has no visible geometry.");
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
        controls.target.copy(center);
        camera.near = Math.max(radius / 100, 0.001);
        camera.far = Math.max(radius * 100, 100);
        camera.position.copy(center).add(new THREE.Vector3(radius * 1.6, radius, radius * 2.2));
        camera.updateProjectionMatrix();
        controls.update();

        const resize = () => {
          const width = Math.max(mount.clientWidth, 1);
          const height = Math.max(mount.clientHeight, 1);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(mount);
        resize();

        const animate = () => {
          controls.update();
          renderer.render(scene, camera);
          frame = window.requestAnimationFrame(animate);
        };
        animate();
        setLoading(false);
      } catch (cause) {
        cleanup();
        if (!disposed) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "Could not load this model.");
        }
      }
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [safeSrc]);

  return (
    <div className={`relative min-h-64 overflow-hidden bg-neutral-900 ${className ?? ""}`}>
      <div ref={mountRef} className="absolute inset-0" role="img" aria-label={title} />
      {(loading || error) && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-neutral-300">
          {error ? (
            <div className="space-y-2">
              <Box className="mx-auto h-8 w-8 opacity-60" />
              <p>{error}</p>
            </div>
          ) : (
            "Loading 3D model…"
          )}
        </div>
      )}
    </div>
  );
}

interface ModelViewerProps {
  path: string;
  title: string;
}

export function ModelViewer({ path, title }: ModelViewerProps) {
  const src = assetUrlFor(path);
  const filename = path.split("/").pop() || path;
  const ext = filename.split(".").pop()?.toUpperCase() || "3D";

  return (
    <ViewerLayout
      toolbar={
        <ViewerToolbar path={path} badge={ext}>
          <ToolbarButton
            icon={Download}
            label="Download"
            onClick={() => {
              const link = document.createElement("a");
              link.href = src;
              link.download = filename;
              link.click();
            }}
          />
        </ViewerToolbar>
      }
    >
      <ModelCanvas src={src} title={title} className="h-full min-h-0 flex-1" />
    </ViewerLayout>
  );
}
