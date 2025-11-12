
import prisma from "../../config/database";
import { startOfMonth, endOfMonth } from "date-fns";
import * as XLSX from "xlsx";


function parseDateFromDDMMYYYY(dateStr: string): Date {
  const [day, month, year] = dateStr.split('/').map(Number);
  return new Date(year, month - 1, day);
}

export const obtenerCuadreOperaciones = async (req: any, res: any) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const search = (req.query.search as string)?.trim() || "";
  const tipo_cliente = (req.query.tipoCliente as string)?.trim() || "";
  const tipo = (req.query.tipo as string)?.trim() || "";
  const fecha = (req.query.fecha as string)?.trim() || "";

  const searchLower = search.toLowerCase();

  const whereConditions: any = {
    usuario: {
      OR: [
        { apellido_paterno: { contains: searchLower } },
        { apellido_materno: { contains: searchLower } },
        { apellido_paterno_apo: { contains: searchLower } },
        { apellido_materno_apo: { contains: searchLower } },
        { nombres: { contains: searchLower } },
        { cliente: { contains: searchLower } },
        { cliente_2: { contains: searchLower } },
        { email: { contains: searchLower } },
        { documento: { contains: searchLower } },
        { documento_2: { contains: searchLower } },
        { documento_tercero: { contains: searchLower } },
      ],
    },
  };

  if (tipo_cliente) {
    whereConditions.usuario.tipo_cliente = {
      contains: tipo_cliente,
    };
  }

  if (tipo) {
    whereConditions.tipo = {
      equals: tipo,
    };
  }
  if (fecha) {
    const mesesMap: { [key: string]: number } = {
      enero: 0,
      febrero: 1,
      marzo: 2,
      abril: 3,
      mayo: 4,
      junio: 5,
      julio: 6,
      agosto: 7,
      septiembre: 8,
      octubre: 9,
      noviembre: 10,
      diciembre: 11,
    };

    const mesNumero = mesesMap[fecha.toLowerCase()];
    if (mesNumero !== undefined) {
      const now = new Date();
      const year = now.getFullYear(); // podrías hacerlo dinámico si lo necesitás
      const fechaReferencia = new Date(year, mesNumero, 1);

      const startDate = startOfMonth(fechaReferencia);
      const endDate = endOfMonth(fechaReferencia);

      whereConditions.fecha = {
        gte: startDate,
        lte: endDate,
      };
    }
  }

  try {
    const total = await prisma.operacion.count();

    const operaciones = await prisma.operacion.findMany({
      skip,
      take: limit,

      include: {
        tipoCambio: {
          omit: {
            id: true,
          },
        },
        flujoFondos: {
          omit: {
            id: true,
          },
        },
        usuario: {
          select: {
            apellido_materno: true,
            apellido_paterno: true,
            nombres: true,
          },
        },
        cuadreOperacion: {
          include: {
            CuadreOperacionDolares: true,
            CuadreOperacionSoles: true,
          },
        },
      },
      orderBy: {
        fecha: "desc"
      },

      where: whereConditions,
    });

    const resultado = await Promise.all(
      operaciones.map(async (op) => {
        if (!op.cuadreOperacion?.id) {
          return {
            ...op,
            cuadreIncompleto: true,
            cuadreCompleto: { cuadre_soles: false, cuadre_dolares: false },
          };
        }

        const sumaUsd =
          op.cuadreOperacion?.CuadreOperacionDolares?.reduce(
            (acc, val) => acc + val.monto_usd,
            0
          ) ?? 1;

        if (op.cuadreOperacion?.CuadreOperacionDolares ?? 0 > 0) {
          const cuadreDolares = op.cuadreOperacion?.CuadreOperacionDolares[0];
          if (cuadreDolares) {
            cuadreDolares.monto_usd = Number(sumaUsd.toFixed(2));
          }
        }

        const sumaPen =
          op.cuadreOperacion?.CuadreOperacionSoles?.reduce(
            (acc, val) => acc + val.monto_pen,
            0
          ) ?? 1;

        if (op.cuadreOperacion?.CuadreOperacionSoles ?? 0 > 0) {
          const cuadreSoles = op.cuadreOperacion?.CuadreOperacionSoles[0];
          if (cuadreSoles) {
            cuadreSoles.monto_pen = Number(sumaPen.toFixed(2));
          }
        }

        const [cuadreDolares, cuadreSoles] = await Promise.all([
          prisma.cuadreOperacionDolares.findFirst({
            where: { cuadreOperacionId: op.cuadreOperacion.id },
          }),
          prisma.cuadreOperacionSoles.findFirst({
            where: { cuadreOperacionId: op.cuadreOperacion.id },
          }),
        ]);

        const [cuadreDolaresAll, cuadreSolesAll] = await Promise.all([
          prisma.cuadreOperacionDolares.findMany({
            where: { cuadreOperacionId: op.cuadreOperacion.id },
          }),
          prisma.cuadreOperacionSoles.findMany({
            where: { cuadreOperacionId: op.cuadreOperacion.id },
          }),
        ]);

        const cuadreCompleto = {
          cuadre_soles: Boolean(cuadreSoles),
          cuadre_dolares: Boolean(cuadreDolares),
        };
        const cuadreIncompleto = !(cuadreDolares || cuadreSoles);

        return {
          ...op,
          cuadreIncompleto,
          cuadreCompleto,
          cuadreDolaresAll,
          cuadreSolesAll,
        };
      })
    );

    res.json({
      data: resultado,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error al obtener operaciones:", error);
    res.status(500).json({ mensaje: "Error interno del servidor" });
  }
};

export const registrarCuadreOperacionDolar = async (req: any, res: any) => {
  try {
    const {
      operacionId,
      fecha_usd,
      descripcion_op_usd,
      monto_usd,
      referencia_usd,
      diferencia_usd,
    } = req.body;

    let cuadreOperacionExistente = await prisma.cuadreOperacion.findUnique({
      where: { operacionId },
    });

    if (!cuadreOperacionExistente) {
      cuadreOperacionExistente = await prisma.cuadreOperacion.create({
        data: {
          operacion: {
            connect: { id: operacionId },
          },
        },
      });
    }

    const nuevoCuadreDolar = await prisma.cuadreOperacionDolares.create({
      data: {
        cuadreOperacion: {
          connect: { id: cuadreOperacionExistente.id },
        },
        fecha_usd: parseDateFromDDMMYYYY(fecha_usd),
        descripcion_op_usd,
        monto_usd,
        referencia_usd,
        diferencia_usd,
      },
    });

    return res.status(201).json(nuevoCuadreDolar);
  } catch (error) {
    console.error("Error registrando CuadreOperacionDolar:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

export const editarCuadreOperacionDolar = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const {
      fecha_usd,
      descripcion_op_usd,
      monto_usd,
      referencia_usd,
      diferencia_usd,
    } = req.body;

    const cuadreDolarExistente = await prisma.cuadreOperacionDolares.findUnique(
      {
        where: { id: Number(id) },
      }
    );

    if (!cuadreDolarExistente) {
      return res
        .status(404)
        .json({ error: "CuadreOperacionDolar no encontrado" });
    }

    const cuadreOperacionActualizada =
      await prisma.cuadreOperacionDolares.update({
        where: { id: Number(id) },
        data: {
          fecha_usd: parseDateFromDDMMYYYY(fecha_usd),
          descripcion_op_usd,
          monto_usd,
          referencia_usd,
          diferencia_usd,
        },
      });

    res.status(200).json(cuadreOperacionActualizada);
  } catch (error) {
    console.error("Error editando CuadreOperacionDolar:", error);
    res.status(500).json({ error: `Error interno del servidor, ${error}` });
  }
};

export const registrarCuadreOperacionSoles = async (req: any, res: any) => {
  try {
    const {
      operacionId,
      fecha_pen,
      descripcion_op_pen,
      monto_pen,
      referencia_pen,
      diferencia_pen,
    } = req.body;

    let cuadreOperacionExistente = await prisma.cuadreOperacion.findUnique({
      where: { operacionId },
    });

    if (!cuadreOperacionExistente) {
      cuadreOperacionExistente = await prisma.cuadreOperacion.create({
        data: {
          operacion: {
            connect: { id: operacionId },
          },
        },
      });
    }

    const nuevoCuadreSoles = await prisma.cuadreOperacionSoles.create({
      data: {
        cuadreOperacion: {
          connect: { id: cuadreOperacionExistente.id },
        },
        fecha_pen: parseDateFromDDMMYYYY(fecha_pen),
        descripcion_op_pen,
        monto_pen,
        referencia_pen,
        diferencia_pen,
      },
    });

    res.status(201).json(nuevoCuadreSoles);
  } catch (error) {
    console.error("Error registrando CuadreOperacionSoles:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
};

export const editarCuadreOperacionSoles = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const {
      fecha_pen,
      descripcion_op_pen,
      monto_pen,
      referencia_pen,
      diferencia_pen,
    } = req.body;

    const cuadreSolesExistente = await prisma.cuadreOperacionSoles.findUnique({
      where: { id: Number(id) },
    });

    if (!cuadreSolesExistente) {
      return res
        .status(404)
        .json({ error: "CuadreOperacionSoles no encontrado" });
    }

    const cuadreOperacionActualizada = await prisma.cuadreOperacionSoles.update(
      {
        where: { id: Number(id) },
        data: {
          fecha_pen: parseDateFromDDMMYYYY(fecha_pen),
          descripcion_op_pen,
          monto_pen,
          referencia_pen,
          diferencia_pen,
        },
      }
    );

    res.status(200).json(cuadreOperacionActualizada);
  } catch (error) {
    console.error("Error editando CuadreOperacionSolesr:", error);
    res.status(500).json({ error: `Error interno del servidor, ${error}` });
  }
};

export const traerCuadresPorId = async (req: any, res: any) => {
  const { id } = req.params;
  try {
    const cuadreOperacion = await prisma.cuadreOperacion.findUnique({
      where: {
        operacionId: parseInt(id),
      },
      select: {
        id: true,
        created_at: true,
        updated_at: true,
        CuadreOperacionDolares: true,
        CuadreOperacionSoles: true,
      },
    });

    if (!cuadreOperacion) {
      return res.status(404).json({ error: "Cuadre no encontrado" });
    }

    res.json({ cuadreOperacion });
  } catch (error) {
    console.error("Error al obtener el cuadre:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
};

// export const editarCuadreOperacion = async (req: any, res: any) => {
//   try {
//     const { id } = req.params;
//     const {
//       fecha_usd,
//       descripcion_op_usd,
//       monto_usd,
//       referencia_usd,
//       diferencia_usd,
//       fecha_pen,
//       descripcion_op_pen,
//       monto_pen,
//       referencia_pen,
//       diferencia_pen,
//     } = req.body;

//     const cuadreExistente = await prisma.cuadreOperacion.findUnique({
//       where: { id: Number(id) },
//     });

//     if (!cuadreExistente) {
//       return res
//         .status(404)
//         .json({ error: "Cuadre de operación no encontrado" });
//     }

//     const cuadreActualizado = await prisma.cuadreOperacion.update({
//       where: { id: Number(id) },
//       data: {
//         fecha_usd: new Date(fecha_usd),
//         descripcion_op_usd,
//         monto_usd,
//         referencia_usd,
//         diferencia_usd,
//         fecha_pen: new Date(fecha_pen),
//         descripcion_op_pen,
//         monto_pen,
//         referencia_pen,
//         diferencia_pen,
//       },
//     });

//     res.status(200).json({
//       data: cuadreActualizado,
//       message: "Cuadre de operación actualizado",
//     });
//   } catch (error) {
//     console.error("Error editando CuadreOperacion:", error);
//     res.status(500).json({ error: "Error interno del servidor" });
//   }
// };

// const operacionesConSuma = operaciones.map((op) => {
//     const sumaUsd =
//       op.cuadreOperacion?.CuadreOperacionDolares?.reduce(
//         (acc, val) => acc + val.monto_usd,
//         0
//       ) ?? 1;

//     // Modificar el monto_usd en CuadreOperacionDolares, si existe
//     if (op.cuadreOperacion?.CuadreOperacionDolares ?? 0 > 0) {
//       // Cambiar el monto_usd del primer registro
//       const cuadreDolares = op.cuadreOperacion?.CuadreOperacionDolares[0];
//       if (cuadreDolares) {
//         cuadreDolares.monto_usd = sumaUsd; // Cambiar a un valor deseado
//       }
//     }

//     return {
//       ...op,
//       suma_diferencia_usd: sumaUsd,
//     };
//   });

export const exportarCuadreOperacionesExcel = async (req: any, res: any) => {
  const { tipo } = req.params;
  const whereCondition =
    tipo.toLowerCase() === "todos" ? {} : { tipo: tipo.toUpperCase() };
  try {
    const operaciones = await prisma.operacion.findMany({
      include: {
        cuadreOperacion: {
          include: {
            CuadreOperacionDolares: true,
            CuadreOperacionSoles: true,
            operacion: {
              include: {
                usuario: true,
              },
            },
          },
        },
        flujoFondos: true
      },
      where: whereCondition,
    });

    const headers = [
      // Datos de la operación
      "Fecha Operación",
      "Número",
      "Cliente/Titular",
      "Tipo",
      "Dólares",
      "Soles",
      // Cuadre en USD
      "Fecha USD",
      "Descripción USD",
      "Monto USD",
      "Referencia USD",
      "Diferencia USD",
      // Cuadre en PEN
      "Fecha PEN",
      "Descripción PEN",
      "Monto PEN",
      "Referencia PEN",
      "Diferencia PEN",
    ];

    const rows: any[] = [];

    operaciones.forEach((op) => {
      const usdCuadres = op.cuadreOperacion?.CuadreOperacionDolares || [null];
      const penCuadres = op.cuadreOperacion?.CuadreOperacionSoles || [null];

      // Obtener la cantidad máxima para combinar todos los cuadres
      const maxCuadres = Math.max(usdCuadres.length, penCuadres.length);

      for (let i = 0; i < maxCuadres; i++) {
        const usd: any = usdCuadres[i] || {};
        const pen: any = penCuadres[i] || {};
        let diferenciaUsd = 0
        let diferenciaPEN = 0

        if (op.cuadreOperacion) {
          let montoTotal = op.tipo === "VENTA" ? Number(-op.dolares) : Math.abs(Number(op.dolares || 0))
          let montoTotalSoles = Number(op.flujoFondos.montoPEN || 0)

          op.cuadreOperacion.CuadreOperacionDolares.forEach(cuadreDolares => {
            console.log(montoTotal , cuadreDolares.monto_usd)
            montoTotal = Number(montoTotal) - Number(cuadreDolares.monto_usd || 0)
          })
          op.cuadreOperacion.CuadreOperacionSoles.forEach(cuadreSoles => {
            console.log(montoTotalSoles , cuadreSoles.monto_pen)
            montoTotalSoles = Number(montoTotalSoles) - Number(cuadreSoles.monto_pen || 0)
          })

          diferenciaPEN = Number(Number(montoTotalSoles).toFixed(2))

          diferenciaUsd = Number(Number(montoTotal).toFixed(2))

          op.cuadreOperacion
        } else {
          diferenciaPEN = Number(Number(op.flujoFondos.montoPEN).toFixed(2)) * -1
          diferenciaUsd = Number(Number(op.dolares).toFixed(2)) * -1
        }

        rows.push([
          // Datos de la operación
          op.fecha.toISOString().split("T")[0],
          op.numero,
          op.cuadreOperacion?.operacion.usuario.cliente,
          op.tipo,
          op.tipo === "COMPRA" ? op.dolares : -op.dolares,
          op.flujoFondos.montoPEN,
          // Cuadre USD
          usd.fecha_usd ? usd.fecha_usd.toISOString().split("T")[0] : "",
          usd.descripcion_op_usd ?? "",
          usd.monto_usd ?? "",
          usd.referencia_usd ?? "",
          diferenciaUsd,
          // Cuadre PEN
          pen.fecha_pen ? pen.fecha_pen.toISOString().split("T")[0] : "",
          pen.descripcion_op_pen ?? "",
          pen.monto_pen ?? "",
          pen.referencia_pen ?? "",
          diferenciaPEN,
        ]);
      }
    });

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Cuadre Operaciones");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=cuadre-operaciones.xlsx"
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(buffer);
  } catch (error) {
    console.error("Error exportando cuadre operaciones:", error);
    res.status(500).json({ message: "Error exportando cuadre operaciones" });
  }
};
