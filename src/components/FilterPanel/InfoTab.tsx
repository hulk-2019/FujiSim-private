import {
  Info,
  Camera,
  Aperture,
  Timer,
  Ruler,
  Calendar,
  HardDrive,
  Star,
  FileType,
  ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "@/store";
import { formatBytes, shortDate } from "@/lib/utils";
import { orientationCss } from "@/lib/orientation";
import { useAssetThumbnail } from "@/hooks/useAssetThumbnail";

export function InfoTab() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const focusedId = useStore((s) => s.focusedId);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;
  const thumbnail = useAssetThumbnail(focused);

  if (!focused) {
    return (
      <div className="flex flex-col items-center justify-center text-zinc-500 py-10 gap-2">
        <Info size={32} />
        <p>{t("filterPanel.noSelection")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-xs pt-3">
      <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 p-3 flex gap-3">
        <div className="w-16 h-16 flex-shrink-0 rounded overflow-hidden bg-zinc-900 border border-zinc-800/60 flex items-center justify-center">
          {thumbnail ? (
            <img
              src={thumbnail.src}
              alt=""
              className="w-full h-full object-cover"
              style={orientationCss(thumbnail.orientation)}
              draggable={false}
            />
          ) : (
            <ImageIcon size={20} className="text-zinc-700" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-zinc-100 font-medium truncate" title={focused.file_name}>{focused.file_name}</p>
          <p className="text-zinc-500 break-all leading-relaxed text-[11px]" title={focused.file_path}>{focused.file_path}</p>
        </div>
      </div>

      <InfoGroup>
        <InfoRow Icon={Camera} label={t("filterPanel.metaCamera")} value={focused.camera_model} />
        <InfoRow Icon={ImageIcon} label={t("filterPanel.metaLens")} value={focused.lens_model} />
      </InfoGroup>

      <InfoGroup>
        <InfoRow Icon={Aperture} label={t("filterPanel.metaAperture")}
          value={focused.f_number != null ? `f/${focused.f_number.toFixed(1)}` : null} />
        <InfoRow Icon={Timer} label={t("filterPanel.metaShutter")}
          value={focused.shutter_speed ? `${focused.shutter_speed}s` : null} />
        <InfoRow Icon={Ruler} label={t("filterPanel.metaFocal")}
          value={focused.focal_length != null ? `${focused.focal_length}mm` : null} />
      </InfoGroup>

      <InfoGroup>
        <InfoRow Icon={Calendar} label={t("filterPanel.metaDate")} value={shortDate(focused.date_taken)} />
        <InfoRow Icon={HardDrive} label={t("filterPanel.metaSize")} value={formatBytes(focused.file_size)} />
        <InfoRow Icon={FileType} label={t("filterPanel.metaType")}
          value={focused.file_type || (focused.is_raw ? "RAW" : null)} />
        <InfoRow Icon={Star} label={t("filterPanel.metaRating")}
          valueNode={
            <div className="flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} size={11}
                  className={n <= focused.star_rating ? "text-amber-400 fill-amber-400" : "text-zinc-700"} />
              ))}
            </div>
          } />
      </InfoGroup>
    </div>
  );
}

export function InfoGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 divide-y divide-zinc-800/60">
      {children}
    </div>
  );
}

export function InfoRow({
  Icon, label, value, valueNode,
}: {
  Icon: LucideIcon;
  label: string;
  value?: string | null;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 min-w-0">
      <Icon size={12} className="text-zinc-500 flex-shrink-0" />
      <span className="text-zinc-500 text-[11px] flex-shrink-0">{label}</span>
      <div className="ml-auto min-w-0 text-right">
        {valueNode ?? (
          <span className="text-zinc-200 truncate block" title={value ?? undefined}>
            {value || "—"}
          </span>
        )}
      </div>
    </div>
  );
}
