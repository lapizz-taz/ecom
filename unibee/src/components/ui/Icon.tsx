import {
  BookOpen, CalendarDays, ClipboardCheck, Clock, FileText, FolderCheck, FolderUp, Headphones, Landmark, Languages,
  Mail, MessageCircle, Mic, MonitorPlay, MousePointerClick, PenLine, PlaneTakeoff, School, Send, Stamp, UserCheck, Users,
  type LucideIcon,
} from "lucide-react";

/** Icons that content files (services, process, English Prep) can refer to by name. */
const ICONS: Record<string, LucideIcon> = {
  BookOpen, CalendarDays, ClipboardCheck, Clock, FileText, FolderCheck, FolderUp, Headphones, Landmark, Languages,
  Mail, MessageCircle, Mic, MonitorPlay, MousePointerClick, PenLine, PlaneTakeoff, School, Send, Stamp, UserCheck, Users,
};

export function Icon({ name, className, strokeWidth = 1.75 }: { name: string; className?: string; strokeWidth?: number }) {
  const C = ICONS[name] ?? ClipboardCheck;
  return <C className={className} strokeWidth={strokeWidth} aria-hidden="true" />;
}
